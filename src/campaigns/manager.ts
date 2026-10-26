import { mkdir, readFile, writeFile, rm, readdir, rename } from "node:fs/promises";
import { EvaluationEngine, DEFAULT_EVALUATION_CONFIG } from "../evaluation/engine.js";
import type { ExperimentEvidence, EvaluationConfig } from "../evaluation/types.js";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ExperimentManager } from "../experiments/manager.js";
import { RecoveryManager } from "../recovery/manager.js";
import { computeFileManifest } from "../storage/snapshot.js";
import { safeRelativePath, isPathInside, resolveInside } from "../security/paths.js";
import { SecretRedactor } from "../security/redactor.js";
import { LockManager } from "../coordination/lock-manager.js";
import { TransactionManager } from "../transactions/manager.js";
import type { CampaignComparison, CampaignExperiment, CampaignExperimentDefinition, CampaignRecord, CampaignStatus } from "./types.js";

const VALID_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  planned: ["ready", "running", "cancelled", "failed", "interrupted"],
  ready: ["running", "cancelled", "failed", "interrupted"],
  running: ["evaluating", "completed", "failed", "cancelled", "blocked", "interrupted"],
  evaluating: ["completed", "failed", "cancelled", "blocked", "interrupted"],
  completed: [],
  failed: ["ready", "running", "cancelled", "interrupted"],
  cancelled: [],
  blocked: ["ready", "running", "cancelled", "interrupted"],
  interrupted: ["ready", "running", "cancelled", "failed", "blocked"],
};

export class CampaignManager {
  private baseDir: string;
  private campaignsDir: string;
  private experimentManager: ExperimentManager;
  private recoveryManager: RecoveryManager;
  private redactor: SecretRedactor;
  private lockManager: LockManager;
  private transactionManager: TransactionManager;
  private evaluationEngine = new EvaluationEngine();
  private cancelFlags = new Set<string>();

  constructor(baseDir: string, experimentManager: ExperimentManager, recoveryProvider?: any, transactionManager?: TransactionManager) {
    this.baseDir = baseDir;
    this.campaignsDir = path.join(baseDir, "campaigns");
    this.experimentManager = experimentManager;
    this.recoveryManager = new RecoveryManager(experimentManager, recoveryProvider);
    this.redactor = new SecretRedactor();
    this.lockManager = new LockManager(baseDir);
    this.transactionManager = transactionManager ?? new TransactionManager(baseDir, experimentManager, this.lockManager);
  }

  async init(): Promise<void> {
    await mkdir(this.campaignsDir, { recursive: true });
    await this.lockManager.init();
    await this.transactionManager.init();
    await this.reconcile();
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.lockManager.withLock(`campaign:${id}`, fn, 10000);
  }

  async reconcile(): Promise<void> {
    for (const record of await this.list().catch(() => [])) {
      if (record.status !== "running" && record.status !== "evaluating") continue;
      let interrupted = false;
      for (const exp of record.experiments) {
        if (!exp.experimentId) continue;
        try {
          const full = await this.experimentManager.inspect(exp.experimentId);
          if (full.status === "running" || full.status === "created" || full.status === "restored") interrupted = true;
        } catch {
          interrupted = true;
        }
      }
      if (interrupted) {
        try { this.transition(record, "interrupted"); } catch { record.status = "interrupted"; }
        record.failure = this.redactor.redactText("Campaign was interrupted during a previous process and was not marked successful.");
        await this.write(record).catch(() => undefined);
      }
    }
  }

  private campaignDir(id: string): string {
    return path.join(this.campaignsDir, id);
  }

  private statePath(id: string): string {
    return path.join(this.campaignDir(id), "campaign.json");
  }

  private async read(id: string): Promise<CampaignRecord> {
    const raw = await readFile(this.statePath(id), "utf8");
    return JSON.parse(raw) as CampaignRecord;
  }

  private async write(record: CampaignRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await mkdir(this.campaignDir(record.id), { recursive: true });
    const target = this.statePath(record.id);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2));
    await rename(temp, target);
  }

  private transition(record: CampaignRecord, next: CampaignStatus): void {
    if (record.status === next) return;
    if (!VALID_TRANSITIONS[record.status].includes(next)) {
      throw new Error(`invalid campaign transition: ${record.status} -> ${next}`);
    }
    record.status = next;
  }

  async create(name: string, input: {
    sourceProject: string;
    objective: string;
    successCriteria?: string;
    maxConcurrency?: number;
    experiments: CampaignExperimentDefinition[];
  }): Promise<CampaignRecord> {
    const sourceProject = path.resolve(input.sourceProject);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record: CampaignRecord = {
      id,
      name,
      status: "planned",
      createdAt: now,
      updatedAt: now,
      sourceProject,
      sourceManifest: await computeFileManifest(sourceProject),
      objective: input.objective,
      successCriteria: input.successCriteria,
      maxConcurrency: Math.max(1, Math.min(input.maxConcurrency ?? 1, 8)),
      experiments: input.experiments.map((exp) => ({
        name: exp.name,
        hypothesis: exp.hypothesis,
        objective: exp.objective,
        method: exp.method,
        expectedOutcome: exp.expectedOutcome,
        status: "planned",
      })),
      baselineCheckpointIds: {},
      recoveryAttempts: [],
    };
    await this.write(record);
    return record;
  }

  async inspect(id: string): Promise<CampaignRecord> {
    return this.read(id);
  }

  async list(): Promise<CampaignRecord[]> {
    if (!existsSync(this.campaignsDir)) return [];
    const entries = await readdir(this.campaignsDir, { withFileTypes: true });
    const records: CampaignRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { records.push(await this.read(entry.name)); } catch { /* ignore */ }
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private async ensureExperiments(record: CampaignRecord, definitions: CampaignExperimentDefinition[]): Promise<void> {
    for (let i = 0; i < record.experiments.length; i++) {
      const campaignExp = record.experiments[i];
      if (campaignExp.experimentId) continue;
      const def = definitions[i];
      if (!def) throw new Error(`missing experiment definition for ${campaignExp.name}`);
      const experiment = await this.experimentManager.create(`${record.name}-${campaignExp.name}`, {
        sourceProject: record.sourceProject,
        env: def.env,
        timeoutMs: def.timeoutMs,
        resourceLimits: def.resourceLimits,
        networkMode: "none",
      });
      campaignExp.experimentId = experiment.id;
      campaignExp.status = experiment.status;
      const checkpoint = await this.experimentManager.checkpoint(experiment.id, "campaign baseline");
      record.baselineCheckpointIds[experiment.id] = checkpoint.id;
      campaignExp.baselineCheckpointId = checkpoint.id;
      await this.experimentManager.updateInvestigation(experiment.id, {
        hypothesis: campaignExp.hypothesis,
        objective: campaignExp.objective,
        method: campaignExp.method,
        expectedOutcome: campaignExp.expectedOutcome,
      });
    }
  }

  async start(id: string, definitions: CampaignExperimentDefinition[], options: { serial?: boolean; cancelRequested?: () => boolean } = {}): Promise<CampaignRecord> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (record.status === "planned") this.transition(record, "ready");
      if (record.status !== "ready" && record.status !== "running" && record.status !== "failed" && record.status !== "blocked" && record.status !== "interrupted") {
        throw new Error(`campaign cannot start from status ${record.status}`);
      }
      this.transition(record, "running");
      await this.ensureExperiments(record, definitions);
      await this.write(record);

      const serial = options.serial ?? false;
      const maxConcurrency = serial ? 1 : record.maxConcurrency;
      const pending = record.experiments.filter((e) => e.status === "planned" || e.status === "created" || e.status === "running" || e.status === "restored");

      const queue = [...pending];
      const cancelRequested = () => Boolean(options.cancelRequested?.() || this.cancelFlags.has(id));
      const runOne = async (campaignExp: CampaignExperiment) => {
        if (!campaignExp.experimentId) return;
        if (cancelRequested()) return;
        try {
          const exp = await this.experimentManager.inspect(campaignExp.experimentId);
          if (exp.status === "running" || exp.status === "created" || exp.status === "restored") {
            const def = definitions.find((d) => d.name === campaignExp.name);
            if (def?.command) {
              await this.experimentManager.runCommand(campaignExp.experimentId, def.command, def.args ?? [], { timeoutMs: def.timeoutMs });
            }
          }
          const updated = await this.experimentManager.inspect(campaignExp.experimentId);
          campaignExp.status = updated.status;
        } catch (err) {
          campaignExp.status = "failed";
          record.failure = this.redactor.redactText(err instanceof Error ? err.message : String(err));
        }
      };

      const workers: Promise<void>[] = [];
      let index = 0;
      const worker = async () => {
        while (index < queue.length && !cancelRequested()) {
          const current = queue[index++];
          await runOne(current);
        }
      };
      for (let i = 0; i < Math.min(Math.max(1, maxConcurrency), queue.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      for (const campaignExp of record.experiments) {
        if (campaignExp.experimentId) {
          try {
            const updated = await this.experimentManager.inspect(campaignExp.experimentId);
            campaignExp.status = updated.status;
          } catch {
            campaignExp.status = "failed";
          }
        }
      }

      if (cancelRequested()) {
        this.transition(record, "cancelled");
        for (const exp of record.experiments) {
          if (exp.experimentId) await this.experimentManager.cancel(exp.experimentId).catch(() => undefined);
          exp.status = "cancelled";
        }
        this.cancelFlags.delete(id);
      } else {
        const anyFailed = record.experiments.some((e) => e.status === "failed");
        if (anyFailed) this.transition(record, "failed");
        else {
          this.transition(record, "evaluating");
          this.transition(record, "completed");
        }
      }
      await this.write(record);
      return record;
    });
  }

  async cancel(id: string): Promise<CampaignRecord> {
    this.cancelFlags.add(id);
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (record.status === "completed" || record.status === "cancelled") {
        this.cancelFlags.delete(id);
        return record;
      }
      try { this.transition(record, "cancelled"); } catch { record.status = "cancelled"; }
      for (const exp of record.experiments) {
        if (exp.experimentId) await this.experimentManager.cancel(exp.experimentId).catch(() => undefined);
        exp.status = "cancelled";
      }
      await this.write(record);
      this.cancelFlags.delete(id);
      return record;
    });
  }

  async compare(id: string): Promise<CampaignRecord> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
    const comparisons: CampaignComparison[] = [];
    const experiments = record.experiments.filter((e) => e.experimentId);
    for (let i = 0; i < experiments.length; i++) {
      for (let j = i + 1; j < experiments.length; j++) {
        const left = experiments[i].experimentId!;
        const right = experiments[j].experimentId!;
        const details = await this.experimentManager.compareExperiments(left, right);
        comparisons.push({
          leftId: left,
          rightId: right,
          summary: `Compared ${experiments[i].name} and ${experiments[j].name}`,
          comparable: Boolean(details.comparable),
          details,
        });
      }
    }
    record.comparison = comparisons;
    if (record.status === "evaluating" || record.status === "running") this.transition(record, "evaluating");
    await this.write(record);
    return record;
    });
  }

  async selectCandidate(id: string, experimentId: string): Promise<CampaignRecord> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (!record.experiments.some((e) => e.experimentId === experimentId)) throw new Error(`experiment is not part of campaign: ${experimentId}`);
      record.candidate = { experimentId, selectedAt: new Date().toISOString(), approved: false };
      await this.write(record);
      return record;
    });
  }

  async verifyCandidate(id: string): Promise<CampaignRecord> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (!record.candidate) throw new Error("no candidate selected");
      const changeSet = await this.experimentManager.prepareChangeSet(record.candidate.experimentId);
      record.candidate.verificationHash = (changeSet as any).verificationHash;
      record.candidate.verificationHash = record.candidate.verificationHash;
      await this.write(record);
      return record;
    });
  }

  async exportCandidatePatch(id: string): Promise<{ campaignId: string; experimentId: string; patchPath: string; content: string }> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (!record.candidate) throw new Error("no candidate selected");
      const patch = await this.experimentManager.exportPatch(record.candidate.experimentId);
      record.candidate.patchPath = patch.path;
      await this.write(record);
      return { campaignId: id, experimentId: record.candidate.experimentId, patchPath: patch.path, content: this.redactor.redactText(patch.content) };
    });
  }

  async approveCandidate(id: string, approved: boolean, reason?: string): Promise<CampaignRecord> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (!record.candidate) throw new Error("no candidate selected");
      record.candidate.approved = approved;
      record.candidate.approvalReason = this.redactor.redactText(reason ?? "");
      record.candidate.approvedAt = new Date().toISOString();
      await this.write(record);
      return record;
    });
  }

  async applyCandidate(id: string, confirm = false): Promise<CampaignRecord> {
    await this.transactionManager.applyCandidate(this, id, confirm);
    return this.read(id);
  }

  async markCandidatePromoted(id: string): Promise<void> {
    await this.withLock(id, async () => {
      await this.markCandidatePromotedUnlocked(id);
    });
  }

  async markCandidatePromotedUnlocked(id: string): Promise<void> {
    const record = await this.read(id);
    if (record.candidate) {
      record.candidate.promoted = true;
      record.candidate.promotedAt = new Date().toISOString();
    }
    await this.write(record);
  }

  getTransactionManager(): TransactionManager {
    return this.transactionManager;
  }

  async recoverExperiment(id: string, experimentId: string, options: { maxAttempts?: number; timeoutMs?: number; verificationCommand?: { command: string; args?: string[]; timeoutMs?: number }; cancelRequested?: () => boolean } = {}): Promise<CampaignRecord> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
    if (!record.experiments.some((e) => e.experimentId === experimentId)) throw new Error(`experiment is not part of campaign: ${experimentId}`);
    const result = await this.recoveryManager.recover(experimentId, options);
    record.recoveryAttempts.push(...result.attemptHistory.map((a) => ({
      id: String(a.id),
      experimentId,
      attempt: Number(a.attempt),
      classification: String(a.classification),
      hypothesis: String(a.hypothesis),
      appliedChanges: (a.appliedChanges as string[]) ?? [],
      verificationExitCode: (a.verificationExitCode as number | null) ?? null,
      outcome: a.outcome as "succeeded" | "failed" | "stopped",
      startedAt: String(a.startedAt),
      endedAt: String(a.endedAt),
      notes: String(a.notes),
    })));
    await this.write(record);
    return record;
    });
  }

  async evaluateCampaign(id: string, input: { config?: EvaluationConfig; evidence?: Record<string, ExperimentEvidence> } = {}): Promise<any> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      const config = input.config ?? record.evaluationConfig ?? DEFAULT_EVALUATION_CONFIG;
      const configErrors = this.evaluationEngine.validateConfig(config);
      if (configErrors.length > 0) throw new Error(`invalid evaluation config: ${configErrors.join("; ")}`);

      const candidates = [];
      for (const campaignExperiment of record.experiments) {
        if (!campaignExperiment.experimentId) continue;
        const experiment = await this.experimentManager.inspect(campaignExperiment.experimentId);
        const commandFailures = experiment.commands.filter((command) => command.exitCode !== 0 || command.timedOut).length;
        const baseEvidence: ExperimentEvidence = {
          commandFailures,
          commandCount: experiment.commands.length,
        };
        const providedEvidence = input.evidence?.[campaignExperiment.experimentId] ?? {};
        candidates.push({
          experimentId: campaignExperiment.experimentId,
          name: campaignExperiment.name,
          evidence: { ...baseEvidence, ...providedEvidence },
        });
      }

      const report = this.evaluationEngine.evaluateCampaign(config, id, candidates);
      record.evaluationConfig = config;
      record.evaluations = [...(record.evaluations ?? []), report];
      await this.write(record);
      return report;
    });
  }

  async explainFailure(id: string, experimentId?: string): Promise<Record<string, unknown>> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      const targets = record.experiments.filter((experiment) => !experimentId || experiment.experimentId === experimentId);
      const failures = [];

      for (const campaignExperiment of targets) {
        if (!campaignExperiment.experimentId) continue;
        const experiment = await this.experimentManager.inspect(campaignExperiment.experimentId);
        const failedCommands = experiment.commands.filter((command) => command.exitCode !== 0 || command.timedOut);
        const timeline = await this.experimentManager.timeline(experiment.id, 1000);
        let faults: unknown[] = [];
        try {
          const raw = await readFile(path.join(this.experimentManager.getBaseDir(), "experiments", experiment.id, "faults.json"), "utf8");
          const parsed = JSON.parse(raw);
          faults = Array.isArray(parsed) ? parsed : [];
        } catch {
          faults = [];
        }

        const signatures = new Map<string, number>();
        for (const command of failedCommands) {
          const signature = this.redactor.redactText(`${command.command}:${command.exitCode}:${command.stderr.slice(0, 200)}`);
          signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
        }
        const repeatedSignatures = Array.from(signatures.entries())
          .filter(([, count]) => count > 1)
          .map(([signature, count]) => ({ signature, count }));

        const latestCheckpoint = experiment.checkpoints.length ? experiment.checkpoints[experiment.checkpoints.length - 1] : undefined;
        const changedFiles = latestCheckpoint
          ? Object.keys((await this.experimentManager.readCheckpoint(experiment.id, latestCheckpoint)).fileManifest ?? {})
          : [];

        const inferred: Array<{ cause: string; confidence: "low" | "medium"; evidence: string }> = [];
        const combinedStderr = failedCommands.map((command) => command.stderr).join("\n");
        if (/ENOENT|not found|no such file/i.test(combinedStderr)) {
          inferred.push({ cause: "A required file or command may be missing.", confidence: "medium", evidence: "stderr contains a not-found/ENOENT-style message" });
        }
        if (/timeout/i.test(combinedStderr) || failedCommands.some((command) => command.timedOut)) {
          inferred.push({ cause: "The experiment may have exceeded its time budget.", confidence: "medium", evidence: "a command timed out or stderr mentions timeout" });
        }
        if (/TypeError|ReferenceError|SyntaxError/i.test(combinedStderr)) {
          inferred.push({ cause: "The experiment hit a JavaScript runtime or syntax error.", confidence: "medium", evidence: "stderr contains a runtime/syntax error" });
        }
        if (inferred.length === 0) {
          inferred.push({ cause: "No specific root cause is established from the recorded evidence.", confidence: "low", evidence: "available stderr and timeline do not match a known signature" });
        }

        failures.push({
          experimentId: experiment.id,
          name: experiment.name,
          status: experiment.status,
          observed: {
            failedCommandCount: failedCommands.length,
            timedOutCount: failedCommands.filter((command) => command.timedOut).length,
            commandCount: experiment.commands.length,
            checkpointCount: experiment.checkpoints.length,
            latestCheckpoint,
            faultCount: faults.length,
            recoveryAttemptCount: record.recoveryAttempts.filter((attempt) => attempt.experimentId === experiment.id).length,
            ledgerEventCount: timeline.length,
            changedFileCount: changedFiles.length,
          },
          failedCommands: failedCommands.map((command) => ({
            id: command.id,
            command: this.redactor.redactText(command.command),
            args: command.args.map((arg) => this.redactor.redactText(arg)),
            exitCode: command.exitCode,
            timedOut: command.timedOut,
            stderr: this.redactor.redactText(command.stderr.slice(0, 2000)),
          })),
          timeline: timeline.slice(-50),
          faults,
          recoveryAttempts: record.recoveryAttempts.filter((attempt) => attempt.experimentId === experiment.id),
          repeatedSignatures,
          inferred,
        });
      }

      return {
        campaignId: id,
        generatedAt: new Date().toISOString(),
        failureCount: failures.length,
        failures,
        summary: failures.length === 0 ? "No failed experiments were found." : `${failures.length} experiment(s) analyzed.`,
      };
    });
  }

  async report(id: string): Promise<Record<string, unknown>> {
    return this.withLock(id, async () => {
      const record = await this.read(id);
    const experiments = [];
    for (const exp of record.experiments) {
      if (!exp.experimentId) continue;
      const full = await this.experimentManager.inspect(exp.experimentId);
      const faults: unknown[] = [];
      experiments.push({
        name: exp.name,
        experimentId: exp.experimentId,
        status: full.status,
        commands: full.commands.map((c) => ({ command: c.command, exitCode: c.exitCode, timedOut: c.timedOut })),
        checkpoints: full.checkpoints,
        hypothesis: full.hypothesis,
        observedOutcome: full.observedOutcome,
        conclusion: full.conclusion,
        faults,
      });
    }
    const report = {
      campaignId: record.id,
      name: record.name,
      status: record.status,
      objective: record.objective,
      successCriteria: record.successCriteria,
      experiments,
      comparison: record.comparison,
      candidate: record.candidate,
      recoveryAttempts: record.recoveryAttempts,
      generatedAt: new Date().toISOString(),
    };
    record.report = report;
    await this.write(record);
    return report;
    });
  }
}