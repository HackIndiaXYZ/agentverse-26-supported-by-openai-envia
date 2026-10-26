import { mkdir, readFile, writeFile, rm, readdir, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Jailor } from "../runtime/jailor.js";
import { ImageStore } from "../images/store.js";
import { LockManager } from "../coordination/lock-manager.js";
import { ExecutionLedger } from "../ledger/ledger.js";
import { SecretRedactor, RedactionConfigManager } from "../security/redactor.js";
import { createTarSnapshot, extractTarSnapshot, computeFileManifest, clearDirectory, copyDirectoryContents } from "../storage/snapshot.js";
import type { Checkpoint, ExperimentCommandResult, ExperimentConfig, ExperimentRecord, ExperimentStatus } from "./types.js";

export class ExperimentManager {
  private baseDir: string;

  getBaseDir(): string { return this.baseDir; }
  private experimentsDir: string;
  private jailor: Jailor;
  private imageStore: ImageStore;
  private redactor: SecretRedactor;
  private lockManager: LockManager;

  constructor(baseDir: string, jailor: Jailor, imageStore: ImageStore, lockManager?: LockManager) {
    this.baseDir = baseDir;
    this.experimentsDir = path.join(baseDir, "experiments");
    this.jailor = jailor;
    this.imageStore = imageStore;
    this.redactor = new SecretRedactor();
    this.lockManager = lockManager ?? new LockManager(baseDir);
  }

  async init(): Promise<void> {
    await mkdir(this.experimentsDir, { recursive: true });
    await this.lockManager.init();
    const config = await new RedactionConfigManager(this.baseDir).load();
    this.redactor = new SecretRedactor(config);
  }

  private experimentDir(id: string): string {
    return path.join(this.experimentsDir, id);
  }

  private async readRecord(id: string): Promise<ExperimentRecord> {
    const raw = await readFile(path.join(this.experimentDir(id), "experiment.json"), "utf8");
    return JSON.parse(raw) as ExperimentRecord;
  }

  private async writeRecord(record: ExperimentRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await mkdir(this.experimentDir(record.id), { recursive: true });
    const target = path.join(this.experimentDir(record.id), "experiment.json");
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2));
    await rename(temp, target);
  }

  private ledger(record: ExperimentRecord): ExecutionLedger {
    return new ExecutionLedger(record.ledgerPath);
  }

  async create(name: string, config: ExperimentConfig): Promise<ExperimentRecord> {
    const sourceProject = path.resolve(config.sourceProject);
    const sourceStat = await stat(sourceProject);
    if (!sourceStat.isDirectory()) throw new Error(`source project is not a directory: ${sourceProject}`);

    const id = crypto.randomUUID();
    const dir = this.experimentDir(id);
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "checkpoints"), { recursive: true });
    await mkdir(path.join(dir, "runs"), { recursive: true });

    const ledgerPath = path.join(dir, "ledger.jsonl");
    const reportPath = path.join(dir, "report.json");
    const sourceManifest = await computeFileManifest(sourceProject);

    let imageRootfsPath: string | undefined;
    if (config.image) {
      const image = await this.imageStore.resolve(config.image);
      imageRootfsPath = image.rootfsPath;
    }

    // Copy the source project into the jail root by passing sourceProject as rootfsPath.
    const idleCommand = process.platform === "win32" ? "cmd" : "sh";
    const idleArgs = process.platform === "win32" ? ["/c", "timeout", "/t", "3600", "/nobreak"] : ["-c", "sleep 3600"];
    const jail = await this.jailor.createJail({
      name: `experiment-${id.slice(0, 8)}`,
      command: config.command || idleCommand,
      args: config.args ?? (config.command ? [] : idleArgs),
      env: config.env ?? {},
      workingDirectory: "/",
      networkMode: config.networkMode ?? "none",
      networks: config.networks,
      limits: config.resourceLimits,
      isolationRequired: false,
      allowUnsafeHostProcess: true,
      rootfsPath: imageRootfsPath ?? sourceProject,
    });

    const record: ExperimentRecord = {
      id,
      name,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceProject,
      sourceManifest,
      jailId: jail.id,
      rootDir: jail.rootDir,
      config: this.redactor.redactObject(config) as ExperimentConfig,
      checkpoints: [],
      commands: [],
      ledgerPath,
      reportPath,
    };

    await this.writeRecord(record);
    const ledger = this.ledger(record);
    await ledger.append("experiment.created", { id, name, sourceProject });

    await this.jailor.startJail(jail.id);
    record.status = "running";
    await this.writeRecord(record);
    await ledger.append("experiment.started", { jailId: jail.id });
    return record;
  }

  async branch(parentExperimentId: string, checkpointId: string | undefined, name: string): Promise<ExperimentRecord> {
    const parent = await this.readRecord(parentExperimentId);
    const checkpointPath = checkpointId
      ? path.join(this.experimentDir(parentExperimentId), "checkpoints", `${checkpointId}.tar.gz`)
      : undefined;

    let sourceProject = parent.sourceProject;
    let rootfsSource: string | undefined;
    if (checkpointPath && existsSync(checkpointPath)) {
      const tempRoot = path.join(this.experimentsDir, `.restore-${crypto.randomUUID()}`);
      await mkdir(tempRoot, { recursive: true });
      await extractTarSnapshot(checkpointPath, tempRoot);
      rootfsSource = tempRoot;
    } else {
      rootfsSource = parent.sourceProject;
    }

    const config: ExperimentConfig = { ...parent.config, sourceProject: rootfsSource ?? parent.sourceProject };
    const child = await this.create(name, config);
    const childRecord = await this.readRecord(child.id);
    childRecord.parentExperimentId = parentExperimentId;
    childRecord.parentCheckpointId = checkpointId;
    if (rootfsSource && rootfsSource !== parent.sourceProject) {
      // create() copied rootfsSource into the jail; remove temp extraction root.
      await rm(rootfsSource, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.writeRecord(childRecord);
    const ledger = this.ledger(childRecord);
    await ledger.append("experiment.branched", { parentExperimentId, parentCheckpointId: checkpointId });
    return childRecord;
  }

  async checkpoint(experimentId: string, note?: string): Promise<Checkpoint> {
    const record = await this.readRecord(experimentId);
    if (!record.jailId) throw new Error("experiment has no jail");
    const jail = await this.jailor.inspectJail(record.jailId);
    const checkpointId = crypto.randomUUID();
    const archivePath = path.join(this.experimentDir(experimentId), "checkpoints", `${checkpointId}.tar.gz`);
    await createTarSnapshot(jail.rootDir, archivePath);
    const archiveStat = await stat(archivePath);
    const fileManifest = await computeFileManifest(jail.rootDir);
    const checkpoint: Checkpoint = {
      id: checkpointId,
      experimentId,
      createdAt: new Date().toISOString(),
      path: archivePath,
      sizeBytes: archiveStat.size,
      note,
      fileManifest,
    };
    // Store checkpoint metadata in a sidecar file.
    await writeFile(path.join(this.experimentDir(experimentId), "checkpoints", `${checkpointId}.json`), JSON.stringify(checkpoint, null, 2));
    record.checkpoints.push(checkpointId);
    await this.writeRecord(record);
    await this.ledger(record).append("checkpoint.created", { checkpointId, note, sizeBytes: archiveStat.size });
    return checkpoint;
  }

  async restore(experimentId: string, checkpointId: string): Promise<ExperimentRecord> {
    const record = await this.readRecord(experimentId);
    if (!record.jailId) throw new Error("experiment has no jail");
    const jail = await this.jailor.inspectJail(record.jailId);
    const wasRunning = jail.state === "running";
    if (wasRunning) await this.jailor.stopJail(jail.id).catch(() => undefined);

    const checkpointPath = path.join(this.experimentDir(experimentId), "checkpoints", `${checkpointId}.tar.gz`);
    if (!existsSync(checkpointPath)) throw new Error(`checkpoint not found: ${checkpointId}`);
    await validateArchive(checkpointPath);

    const tempRoot = path.join(this.experimentsDir, `.restore-${crypto.randomUUID()}`);
    await mkdir(tempRoot, { recursive: true });
    await extractTarSnapshot(checkpointPath, tempRoot);
    await validateExtractedTree(tempRoot);

    await clearDirectory(jail.rootDir);
    await copyDirectoryContents(tempRoot, jail.rootDir);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (wasRunning) await this.jailor.startJail(jail.id).catch(() => undefined);
    record.status = "restored";
    await this.writeRecord(record);
    await this.ledger(record).append("checkpoint.restored", { checkpointId });
    return record;
  }

  async runCommand(experimentId: string, command: string, args: string[] = [], options: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> } = {}): Promise<ExperimentCommandResult> {
    const record = await this.readRecord(experimentId);
    if (!record.jailId) throw new Error("experiment has no jail");
    const jail = await this.jailor.inspectJail(record.jailId);
    if (jail.state !== "running") {
      await this.jailor.startJail(jail.id);
    }

    const runId = crypto.randomUUID();
    const stdoutPath = path.join(this.experimentDir(experimentId), "runs", `${runId}.stdout`);
    const stderrPath = path.join(this.experimentDir(experimentId), "runs", `${runId}.stderr`);
    const startedAt = new Date().toISOString();
    const result = await this.jailor.execJail(jail.id, command, args, {
      timeoutMs: options.timeoutMs ?? record.config.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env,
    });
    const finishedAt = new Date().toISOString();
    const redactedStdout = this.redactor.redactText(result.stdout);
    const redactedStderr = this.redactor.redactText(result.stderr);
    await writeFile(stdoutPath, redactedStdout);
    await writeFile(stderrPath, redactedStderr);

    const commandResult: ExperimentCommandResult = {
      id: runId,
      command: this.redactor.redactText(command),
      args: this.redactor.redactArgs(args),
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutPath,
      stderrPath,
      stdout: redactedStdout,
      stderr: redactedStderr,
      stdoutHash: sha256(redactedStdout),
      stderrHash: sha256(redactedStderr),
    };
    record.commands.push(commandResult);
    await this.writeRecord(record);
    await this.ledger(record).append("command.executed", {
      runId,
      command: this.redactor.redactText(command),
      args: this.redactor.redactArgs(args),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
    return commandResult;
  }

  async cancel(experimentId: string): Promise<ExperimentRecord> {
    const record = await this.readRecord(experimentId);
    if (record.jailId) await this.jailor.stopJail(record.jailId).catch(() => undefined);
    record.status = "cancelled";
    await this.writeRecord(record);
    await this.ledger(record).append("experiment.cancelled", {});
    return record;
  }

  async complete(experimentId: string, summary?: string): Promise<ExperimentRecord> {
    const record = await this.readRecord(experimentId);
    record.status = "completed";
    record.resultSummary = summary;
    await this.writeRecord(record);
    await this.ledger(record).append("experiment.completed", { summary });
    return record;
  }

  async updateInvestigation(experimentId: string, fields: Partial<Pick<ExperimentRecord, "hypothesis" | "objective" | "method" | "expectedOutcome" | "observedOutcome" | "conclusion" | "confidence" | "evidenceRefs" | "nextSteps">>): Promise<ExperimentRecord> {
    const record = await this.readRecord(experimentId);
    if (fields.hypothesis !== undefined) record.hypothesis = fields.hypothesis;
    if (fields.objective !== undefined) record.objective = fields.objective;
    if (fields.method !== undefined) record.method = fields.method;
    if (fields.expectedOutcome !== undefined) record.expectedOutcome = fields.expectedOutcome;
    if (fields.observedOutcome !== undefined) record.observedOutcome = fields.observedOutcome;
    if (fields.conclusion !== undefined) record.conclusion = fields.conclusion;
    if (fields.confidence !== undefined) record.confidence = fields.confidence;
    if (fields.evidenceRefs !== undefined) record.evidenceRefs = fields.evidenceRefs;
    if (fields.nextSteps !== undefined) record.nextSteps = fields.nextSteps;
    await this.writeRecord(record);
    await this.ledger(record).append("investigation.updated", { fields: Object.keys(fields) });
    return record;
  }

  async compareExperiments(leftId: string, rightId: string): Promise<Record<string, unknown>> {
    const left = await this.readRecord(leftId);
    const right = await this.readRecord(rightId);
    const leftCp = left.checkpoints.length ? await this.readCheckpoint(leftId, left.checkpoints[left.checkpoints.length - 1]) : undefined;
    const rightCp = right.checkpoints.length ? await this.readCheckpoint(rightId, right.checkpoints[right.checkpoints.length - 1]) : undefined;

    const leftFiles = leftCp?.fileManifest ?? left.sourceManifest;
    const rightFiles = rightCp?.fileManifest ?? right.sourceManifest;
    const leftSet = new Set(Object.keys(leftFiles));
    const rightSet = new Set(Object.keys(rightFiles));
    const added = [...rightSet].filter((f) => !leftSet.has(f));
    const removed = [...leftSet].filter((f) => !rightSet.has(f));
    const modified = [...leftSet].filter((f) => rightSet.has(f) && leftFiles[f] !== rightFiles[f]);

    const lastLeft = left.commands[left.commands.length - 1];
    const lastRight = right.commands[right.commands.length - 1];

    return {
      left: leftId,
      right: rightId,
      status: { left: left.status, right: right.status },
      exitCodes: { left: lastLeft?.exitCode ?? null, right: lastRight?.exitCode ?? null },
      outputHashes: { left: lastLeft?.stdoutHash, right: lastRight?.stdoutHash },
      fileDiff: { added, removed, modified },
      faults: {
        left: (await this.readFaults(leftId)).length,
        right: (await this.readFaults(rightId)).length,
      },
      comparable: true,
      notes: "Comparison is based on recorded manifests and command results; external and nondeterministic inputs may make results non-comparable.",
    };
  }

  private async readFaults(experimentId: string): Promise<unknown[]> {
    try {
      const raw = await readFile(path.join(this.experimentDir(experimentId), "faults.json"), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async dispose(experimentId: string): Promise<void> {
    const record = await this.readRecord(experimentId);
    if (record.jailId) await this.jailor.removeJail(record.jailId).catch(() => undefined);
    await rm(this.experimentDir(experimentId), { recursive: true, force: true });
  }

  async list(): Promise<ExperimentRecord[]> {
    if (!existsSync(this.experimentsDir)) return [];
    const entries = await readdir(this.experimentsDir, { withFileTypes: true });
    const records: ExperimentRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        records.push(await this.readRecord(entry.name));
      } catch {
        // ignore corrupt experiment
      }
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async inspect(experimentId: string): Promise<ExperimentRecord> {
    return this.readRecord(experimentId);
  }

  async setRecoveryAttempts(experimentId: string, attempts: Array<Record<string, unknown>>): Promise<ExperimentRecord> {
    const record = await this.readRecord(experimentId);
    record.recoveryAttempts = attempts;
    await this.writeRecord(record);
    return record;
  }

  async setRecoveryBudget(experimentId: string, budget: { maxAttempts: number; deadlineAt: string; createdAt: string }): Promise<ExperimentRecord> {
    const record = await this.readRecord(experimentId);
    record.recoveryBudget = budget;
    await this.writeRecord(record);
    return record;
  }

  async timeline(experimentId: string, limit = 1000): Promise<unknown[]> {
    const record = await this.readRecord(experimentId);
    return this.ledger(record).read(limit);
  }

  async compareCheckpoints(experimentId: string, leftCheckpointId: string, rightCheckpointId: string): Promise<Record<string, unknown>> {
    const left = await this.readCheckpoint(experimentId, leftCheckpointId);
    const right = await this.readCheckpoint(experimentId, rightCheckpointId);
    const leftFiles = new Set(Object.keys(left.fileManifest));
    const rightFiles = new Set(Object.keys(right.fileManifest));
    const added = [...rightFiles].filter((f) => !leftFiles.has(f));
    const removed = [...leftFiles].filter((f) => !rightFiles.has(f));
    const modified = [...leftFiles].filter((f) => rightFiles.has(f) && left.fileManifest[f] !== right.fileManifest[f]);
    return { left: leftCheckpointId, right: rightCheckpointId, added, removed, modified };
  }

  async readCheckpoint(experimentId: string, checkpointId: string): Promise<Checkpoint> {
    const raw = await readFile(path.join(this.experimentDir(experimentId), "checkpoints", `${checkpointId}.json`), "utf8");
    return JSON.parse(raw) as Checkpoint;
  }

  async listCheckpoints(experimentId: string): Promise<Checkpoint[]> {
    const record = await this.readRecord(experimentId);
    const checkpoints: Checkpoint[] = [];
    for (const id of record.checkpoints) {
      try {
        checkpoints.push(await this.readCheckpoint(experimentId, id));
      } catch {
        // ignore
      }
    }
    return checkpoints;
  }

  async replay(experimentId: string): Promise<Record<string, unknown>> {
    const original = await this.readRecord(experimentId);
    const checkpointId = original.checkpoints[0];
    const branch = await this.branch(experimentId, checkpointId, `${original.name}-replay`);
    const replayResults = [];
    for (const command of original.commands) {
      const result = await this.runCommand(branch.id, command.command, command.args, {});
      replayResults.push({
        originalExitCode: command.exitCode,
        replayExitCode: result.exitCode,
        stdoutMatch: command.stdoutHash === result.stdoutHash,
      });
    }
    return { original: original.id, replay: branch.id, results: replayResults };
  }

  async prepareChangeSet(experimentId: string, checkpointId?: string): Promise<Record<string, unknown>> {
    const record = await this.readRecord(experimentId);
    const checkpoint = checkpointId ? await this.readCheckpoint(experimentId, checkpointId) : (record.checkpoints.length ? await this.readCheckpoint(experimentId, record.checkpoints[record.checkpoints.length - 1]) : undefined);
    if (!checkpoint) throw new Error("no checkpoint available");
    if (!record.rootDir) throw new Error("experiment has no root directory");

    // Verify the original project has not changed since the experiment began.
    const currentSourceManifest = await computeFileManifest(record.sourceProject);
    const sourceChanged = Object.keys(currentSourceManifest).some((f) => record.sourceManifest[f] !== currentSourceManifest[f]) ||
      Object.keys(record.sourceManifest).some((f) => currentSourceManifest[f] !== record.sourceManifest[f]);
    const currentManifest = await computeFileManifest(record.rootDir);
    const changedFiles = Object.keys(currentManifest).filter((f) => checkpoint.fileManifest[f] !== currentManifest[f] || !(f in checkpoint.fileManifest));
    const removedFiles = Object.keys(checkpoint.fileManifest).filter((f) => !(f in currentManifest));
    const allChanged = [...new Set([...changedFiles, ...removedFiles])].filter((f) => !this.isInternalPath(f));

    const verificationHash = crypto.createHash("sha256").update(JSON.stringify({ checkpoint: checkpoint.id, files: allChanged, manifest: currentManifest })).digest("hex");
    const changeSet = {
      experimentId,
      checkpointId: checkpoint.id,
      changedFiles: allChanged,
      removedFiles,
      sourceProjectChanged: sourceChanged,
      verificationHash,
      verifiedAt: new Date().toISOString(),
      requiresApproval: true,
      promotionAllowed: !sourceChanged,
      message: sourceChanged
        ? "The original project changed since the experiment began. Resolve conflicts before promotion."
        : "Review the changed files before promoting them to the original project.",
    };
    await writeFile(path.join(this.experimentDir(experimentId), "change-set.json"), JSON.stringify(changeSet, null, 2));
    await this.ledger(record).append("change_set.prepared", { checkpointId: checkpoint.id, changedFiles: allChanged.length, sourceProjectChanged: sourceChanged });
    return changeSet;
  }

  async exportPatch(experimentId: string, checkpointId?: string): Promise<{ path: string; content: string }> {
    const changeSet = await this.prepareChangeSet(experimentId, checkpointId) as { checkpointId: string };
    const record = await this.readRecord(experimentId);
    if (!record.rootDir) throw new Error("experiment has no root directory");

    // Reconstruct the baseline from the checkpoint into a temp directory.
    const checkpointPath = path.join(this.experimentDir(experimentId), "checkpoints", `${changeSet.checkpointId}.tar.gz`);
    const baselineDir = path.join(this.experimentsDir, `.baseline-${crypto.randomUUID()}`);
    await (await import("../storage/snapshot.js")).extractTarSnapshot(checkpointPath, baselineDir);

    const patchPath = path.join(this.experimentDir(experimentId), "candidate.patch");
    let content = "";
    try {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("git", ["diff", "--no-index", "--", baselineDir, record.rootDir], { timeout: 120000 });
        content = stdout;
      } catch (err: any) {
        // git diff returns exit code 1 when differences exist.
        if (typeof err?.stdout === "string" && err.stdout.length > 0) content = err.stdout;
        else content = `Unable to generate a unified diff: ${String(err)}`;
      }
      content = this.redactor.redactText(content);
      await writeFile(patchPath, content);
    } finally {
      await rm(baselineDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { path: patchPath, content };
  }

  private isInternalPath(filePath: string): boolean {
    return filePath.startsWith(".envia/") || filePath === "ledger.jsonl" || filePath === "jail.log" || filePath.endsWith(".tmp");
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function validateArchive(archivePath: string): Promise<void> {
  const { validateArchiveEntries } = await import("../storage/snapshot.js");
  await validateArchiveEntries(archivePath);
}

async function validateExtractedTree(root: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in restored snapshot: ${full}`);
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
}