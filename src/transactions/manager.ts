import { mkdir, readFile, writeFile, rm, readdir, rename, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LockManager } from "../coordination/lock-manager.js";
import { ExperimentManager } from "../experiments/manager.js";
import { safeRelativePath, isPathInside, resolveInside } from "../security/paths.js";
import { SecretRedactor } from "../security/redactor.js";
import type { TransactionRecord, TransactionState, TransactionFileState } from "./types.js";

export class TransactionManager {
  private baseDir: string;
  private transactionsDir: string;
  private experimentManager: ExperimentManager;
  private lockManager: LockManager;
  private redactor: SecretRedactor;

  constructor(baseDir: string, experimentManager: ExperimentManager, lockManager?: LockManager) {
    this.baseDir = baseDir;
    this.transactionsDir = path.join(baseDir, "transactions");
    this.experimentManager = experimentManager;
    this.lockManager = lockManager ?? new LockManager(baseDir);
    this.redactor = new SecretRedactor();
  }

  async init(): Promise<void> {
    await mkdir(this.transactionsDir, { recursive: true });
    await this.lockManager.init();
    await this.reconcile();
  }

  private transactionDir(id: string): string {
    return path.join(this.transactionsDir, id);
  }

  private statePath(id: string): string {
    return path.join(this.transactionDir(id), "transaction.json");
  }

  async list(): Promise<TransactionRecord[]> {
    if (!existsSync(this.transactionsDir)) return [];
    const entries = await readdir(this.transactionsDir, { withFileTypes: true });
    const records: TransactionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.transactionsDir, entry.name, "transaction.json"), "utf8")) as TransactionRecord);
      } catch {
        // Ignore corrupt transaction records; preserve their directories for forensics.
      }
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async inspect(id: string): Promise<TransactionRecord> {
    return JSON.parse(await readFile(this.statePath(id), "utf8")) as TransactionRecord;
  }

  private async write(record: TransactionRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await mkdir(this.transactionDir(record.id), { recursive: true });
    const target = this.statePath(record.id);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2));
    await rename(temp, target);
  }

  private async computeSourceIdentity(sourceProject: string): Promise<string> {
    const manifest = await this.experimentManager ? (await import("../storage/snapshot.js")).computeFileManifest(sourceProject) : {};
    return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  }

  async reconcile(): Promise<void> {
    for (const record of await this.list()) {
      if (record.state === "committed" || record.state === "rolled_back" || record.state === "recovery_required" || record.state === "failed") continue;
      try {
        await this.recover(record.id);
      } catch {
        // Leave the transaction in a recoverable/recovery-required state rather than crashing startup.
      }
    }
  }

  async recover(id: string): Promise<TransactionRecord> {
    return this.lockManager.withLock(`transaction:${id}`, async () => {
      const record = await this.inspect(id);
      if (record.state === "committed" || record.state === "rolled_back") return record;
      if (record.state === "recovery_required") return record;

      record.state = "rolling_back";
      await this.write(record);

      const completed = new Set(record.completedOperations);
      const reversedFiles = [...record.files].reverse();
      let rollbackOk = true;
      const failures: string[] = [];

      for (const file of reversedFiles) {
        const relative = file.relativePath;
        const target = resolveInside(record.sourceProject, relative);
        if (!target) {
          rollbackOk = false;
          failures.push(`unsafe path during rollback: ${relative}`);
          continue;
        }
        const opKey = `${file.existed ? "write" : "delete"}:${relative}`;
        if (!completed.has(relative) && !completed.has(opKey)) {
          // Nothing was applied for this file; nothing to roll back.
          continue;
        }
        try {
          if (file.existed) {
            if (!file.backupPath || !existsSync(file.backupPath)) throw new Error(`missing backup for ${relative}`);
            if (existsSync(target)) {
              const currentHash = crypto.createHash("sha256").update(await readFile(target)).digest("hex");
              if (file.candidateHash && currentHash !== file.candidateHash && currentHash !== file.originalHash) {
                throw new Error(`target changed after application; refusing to overwrite ${relative}`);
              }
              if (currentHash === file.originalHash) continue;
            }
            await mkdir(path.dirname(target), { recursive: true });
            const temp = `${target}.${crypto.randomUUID()}.tmp`;
            await copyFile(file.backupPath, temp);
            await rename(temp, target);
          } else {
            if (existsSync(target)) {
              const currentHash = crypto.createHash("sha256").update(await readFile(target)).digest("hex");
              if (file.candidateHash && currentHash !== file.candidateHash) {
                throw new Error(`target changed after application; refusing to delete ${relative}`);
              }
              await rm(target, { force: true });
            }
          }
          record.rollbackCompleted.push(relative);
          await this.write(record);
        } catch (err) {
          rollbackOk = false;
          failures.push(this.redactor.redactText(String(err)));
        }
      }

      // Verify restored state.
      if (rollbackOk) {
        for (const file of record.files) {
          const target = resolveInside(record.sourceProject, file.relativePath);
          if (!target) { rollbackOk = false; failures.push(`unsafe path during verification: ${file.relativePath}`); break; }
          if (file.existed) {
            if (!existsSync(target)) { rollbackOk = false; failures.push(`missing restored file: ${file.relativePath}`); break; }
            const hash = crypto.createHash("sha256").update(await readFile(target)).digest("hex");
            if (file.originalHash && hash !== file.originalHash) { rollbackOk = false; failures.push(`hash mismatch after rollback: ${file.relativePath}`); break; }
          } else {
            if (existsSync(target)) { rollbackOk = false; failures.push(`file should be absent after rollback: ${file.relativePath}`); break; }
          }
        }
      }

      if (rollbackOk) {
        record.state = "rolled_back";
      } else {
        record.state = "recovery_required";
        record.failure = failures.join("; ");
      }
      await this.write(record);
      return record;
    });
  }

  // Application is invoked by CampaignManager through a thin adapter.
  async applyCandidate(campaignManager: any, campaignId: string, confirm: boolean): Promise<any> {
    if (!confirm) throw new Error("explicit confirmation is required to apply a candidate");

    const campaign = await campaignManager.inspect(campaignId);
    if (!campaign.candidate) throw new Error("no candidate selected");
    if (!campaign.candidate.approved) throw new Error("candidate is not approved");

    const experiment = await this.experimentManager.inspect(campaign.candidate.experimentId);
    const changeSet = await this.experimentManager.prepareChangeSet(campaign.candidate.experimentId) as any;
    if (changeSet.sourceProjectChanged) throw new Error("source project changed since baseline; resolve conflicts first");
    if (campaign.candidate.verificationHash && changeSet.verificationHash !== campaign.candidate.verificationHash) {
      throw new Error("candidate verification is stale; verify the candidate again");
    }

    const sourceProject = campaign.sourceProject;
    const changedFiles = (changeSet.changedFiles ?? []) as string[];
    const removedFiles = (changeSet.removedFiles ?? []) as string[];
    const affected = [...new Set([...changedFiles, ...removedFiles])];

    // Validate all paths before touching the source.
    const relativeFiles: string[] = [];
    for (const file of affected) {
      const relative = safeRelativePath(file);
      if (!relative) throw new Error(`unsafe path in change set: ${file}`);
      relativeFiles.push(relative);
    }

    const sourceLock = await this.lockManager.acquire(`source:${sourceProject}`);
    const campaignLock = await this.lockManager.acquire(`campaign:${campaignId}`);
    try {
      // Revalidate after lock acquisition.
      const freshCampaign = await campaignManager.inspect(campaignId);
      if (!freshCampaign.candidate || freshCampaign.candidate.experimentId !== campaign.candidate.experimentId) throw new Error("candidate changed during application");
      if (!freshCampaign.candidate.approved) throw new Error("candidate is not approved");
      const freshChangeSet = await this.experimentManager.prepareChangeSet(freshCampaign.candidate.experimentId) as any;
      if (freshChangeSet.sourceProjectChanged) throw new Error("source project changed since baseline; resolve conflicts first");
      if (freshCampaign.candidate.verificationHash && freshChangeSet.verificationHash !== freshCampaign.candidate.verificationHash) {
        throw new Error("candidate verification is stale; verify the candidate again");
      }

      const id = crypto.randomUUID();
      const txDir = this.transactionDir(id);
      await mkdir(txDir, { recursive: true });
      await mkdir(path.join(txDir, "staged"), { recursive: true });
      await mkdir(path.join(txDir, "backups"), { recursive: true });

      const sourceIdentity = await this.computeSourceIdentity(sourceProject);
      const operations = [
        ...relativeFiles.filter((f) => changedFiles.includes(f) || changedFiles.includes(f.replace(/\//g, path.sep))).map((f) => ({ type: "write" as const, relativePath: f })),
        ...relativeFiles.filter((f) => removedFiles.includes(f) || removedFiles.includes(f.replace(/\//g, path.sep))).map((f) => ({ type: "delete" as const, relativePath: f })),
      ];
      // Deduplicate operations by path, preferring write over delete.
      const byPath = new Map<string, "write" | "delete">();
      for (const op of operations) {
        if (!byPath.has(op.relativePath) || op.type === "write") byPath.set(op.relativePath, op.type);
      }
      const uniqueOps = [...byPath.entries()].map(([relativePath, type]) => ({ type, relativePath }));

      const files: TransactionFileState[] = [];
      for (const op of uniqueOps) {
        const target = resolveInside(sourceProject, op.relativePath)!;
        const existed = existsSync(target);
        const state: TransactionFileState = { relativePath: op.relativePath, existed };
        if (existed) {
          const backupPath = path.join(txDir, "backups", ...op.relativePath.split("/"));
          await mkdir(path.dirname(backupPath), { recursive: true });
          await copyFile(target, backupPath);
          state.backupPath = backupPath;
          state.originalHash = crypto.createHash("sha256").update(await readFile(target)).digest("hex");
        }
        if (op.type === "write") {
          const src = resolveInside(experiment.rootDir!, op.relativePath);
          if (!src || !existsSync(src)) throw new Error(`candidate file is missing: ${op.relativePath}`);
          const stagedPath = path.join(txDir, "staged", ...op.relativePath.split("/"));
          await mkdir(path.dirname(stagedPath), { recursive: true });
          await copyFile(src, stagedPath);
          state.stagedPath = stagedPath;
          state.candidateHash = crypto.createHash("sha256").update(await readFile(stagedPath)).digest("hex");
        }
        files.push(state);
      }

      const record: TransactionRecord = {
        id,
        state: "prepared",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        campaignId,
        experimentId: campaign.candidate.experimentId,
        candidateSelectedAt: campaign.candidate.selectedAt,
        sourceProject,
        sourceProjectIdentity: sourceIdentity,
        baselineCheckpointId: changeSet.checkpointId,
        baselineManifestHash: crypto.createHash("sha256").update(JSON.stringify(changeSet)).digest("hex"),
        verificationHash: changeSet.verificationHash,
        operations: uniqueOps,
        files,
        completedOperations: [],
        rollbackCompleted: [],
      };
      await this.write(record);

      // Apply.
      record.state = "applying";
      await this.write(record);

      const sortedFiles = [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : 1);
      for (const file of sortedFiles) {
        const op = uniqueOps.find((o) => o.relativePath === file.relativePath)!;
        const target = resolveInside(sourceProject, file.relativePath)!;
        if (op.type === "write") {
          const temp = `${target}.${crypto.randomUUID()}.tmp`;
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(file.stagedPath!, temp);
          await rename(temp, target);
        } else {
          await rm(target, { force: true });
        }
        record.completedOperations.push(file.relativePath);
        await this.write(record);
      }

      // Verify.
      for (const file of sortedFiles) {
        const op = uniqueOps.find((o) => o.relativePath === file.relativePath)!;
        const target = resolveInside(sourceProject, file.relativePath)!;
        if (op.type === "write") {
          const hash = crypto.createHash("sha256").update(await readFile(target)).digest("hex");
          if (hash !== file.candidateHash) throw new Error(`verification failed for ${file.relativePath}`);
        } else {
          if (existsSync(target)) throw new Error(`deleted file still exists: ${file.relativePath}`);
        }
      }

      record.state = "committed";
      await this.write(record);

      await campaignManager.markCandidatePromotedUnlocked(campaignId);

      // Clean staged content but keep journal.
      await rm(path.join(txDir, "staged"), { recursive: true, force: true }).catch(() => undefined);
      await rm(path.join(txDir, "backups"), { recursive: true, force: true }).catch(() => undefined);

      return campaignManager.inspect(campaignId);
    } finally {
      await campaignLock.release();
      await sourceLock.release();
    }
  }
}