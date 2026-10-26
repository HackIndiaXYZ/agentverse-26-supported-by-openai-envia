import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Jailor } from "../runtime/jailor.js";
import { ImageStore } from "../images/store.js";
import { ExecutionLedger } from "../ledger/ledger.js";
import { SecretRedactor, RedactionConfigManager } from "../security/redactor.js";
import type { AgentRunRecord, AgentRunSpec } from "./types.js";

const execFileAsync = promisify(execFile);

export class AgentRunManager {
  private baseDir: string;
  private runsDir: string;
  private jailor: Jailor;
  private imageStore: ImageStore;
  private allowUnsafe: boolean;
  private redactor: SecretRedactor;

  constructor(baseDir: string, jailor: Jailor, imageStore: ImageStore, allowUnsafe: boolean) {
    this.baseDir = baseDir;
    this.runsDir = path.join(baseDir, "runs");
    this.jailor = jailor;
    this.imageStore = imageStore;
    this.allowUnsafe = allowUnsafe;
    this.redactor = new SecretRedactor();
  }

  async init(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    const config = await new RedactionConfigManager(this.baseDir).load();
    this.redactor = new SecretRedactor(config);
  }

  async run(spec: AgentRunSpec): Promise<AgentRunRecord> {
    const id = crypto.randomUUID();
    const runDir = path.join(this.runsDir, id);
    await mkdir(runDir, { recursive: true });
    const ledgerPath = path.join(runDir, "ledger.jsonl");
    const reportPath = path.join(runDir, "report.json");
    const ledger = new ExecutionLedger(ledgerPath);

    const record: AgentRunRecord = {
      id,
      task: spec.task,
      status: "running",
      createdAt: new Date().toISOString(),
      jailId: "",
      spec: this.redactor.redactObject(spec) as AgentRunSpec,
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutHash: "",
      stderrHash: "",
      fileManifestHash: "",
      approved: false,
      reportPath,
      ledgerPath,
    };

    await ledger.append("run.created", { id, task: spec.task });

    let imageRootfsPath: string | undefined;
    let imageEnv: Record<string, string> = {};
    let imageCmd: string[] = [];
    if (spec.image) {
      const image = await this.imageStore.resolve(spec.image);
      imageRootfsPath = image.rootfsPath;
      for (const entry of image.manifest.config.env ?? []) {
        const idx = entry.indexOf("=");
        if (idx !== -1) imageEnv[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
      const fromConfig = image.manifest.config.entrypoint?.length ? image.manifest.config.entrypoint : image.manifest.config.cmd;
      if (Array.isArray(fromConfig)) imageCmd = fromConfig as string[];
    }

    const env = { ...imageEnv, ...(spec.env ?? {}) };
    const command = spec.command || imageCmd[0];
    if (!command) throw new Error("agent run requires a command or image CMD/ENTRYPOINT");
    const args = spec.args && spec.args.length > 0 ? spec.args : (spec.command ? [] : imageCmd.slice(1));
    const workingDirectory = spec.workingDirectory ?? (spec.image ? (await this.imageStore.resolve(spec.image)).manifest.config.workingDir : undefined);

    const jail = await this.jailor.createJail({
      name: `agent-${id.slice(0, 8)}`,
      command,
      args,
      env,
      workingDirectory,
      limits: { runtimeMs: spec.timeoutMs ?? 300000 },
      isolationRequired: false,
      allowUnsafeHostProcess: this.allowUnsafe,
      rootfsPath: imageRootfsPath,
    });
    record.jailId = jail.id;
    await ledger.append("jail.created", { jailId: jail.id, rootfsPath: imageRootfsPath });

    await this.jailor.startJail(jail.id);
    await ledger.append("jail.started", { jailId: jail.id, pid: jail.pid });

    const timeoutMs = spec.timeoutMs ?? 300000;
    const deadline = Date.now() + timeoutMs;
    let current = await this.jailor.inspectJail(jail.id);
    while (current.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await this.jailor.inspectJail(jail.id);
    }
    if (current.state === "running") {
      await this.jailor.stopJail(jail.id);
      current = await this.jailor.inspectJail(jail.id);
    }

    const logs = await this.jailor.logs(jail.id, 100000);
    const stdout = logs.join("\n");
    const stderr = "";
    const exitCode = current.exitCode ?? null;
    const status = exitCode === 0 ? "succeeded" : "failed";

    record.exitCode = exitCode;
    const redactedStdout = this.redactor.redactText(stdout);
    const redactedStderr = this.redactor.redactText(stderr);
    record.stdout = redactedStdout.slice(0, 100000);
    record.stderr = redactedStderr;
    record.stdoutHash = sha256(record.stdout);
    record.stderrHash = sha256(record.stderr);
    record.fileManifestHash = await this.computeFileManifest(path.join(this.baseDir, "runtime", "jails", jail.id));
    record.status = status;
    record.finishedAt = new Date().toISOString();

    await ledger.append("command.finished", { exitCode, status });

    if (spec.checkpoint) {
      const checkpointPath = path.join(runDir, "checkpoint.tar.gz");
      const jailRoot = path.join(this.baseDir, "runtime", "jails", jail.id);
      await execFileAsync("tar", ["-czf", checkpointPath, "-C", jailRoot, "."], { timeout: 300000 });
      record.checkpointPath = checkpointPath;
      await ledger.append("checkpoint.created", { path: checkpointPath });
    }

    record.approved = false;
    await writeFile(reportPath, JSON.stringify(record, null, 2));
    await ledger.append("run.finished", { status, approved: false });
    return record;
  }

  async list(): Promise<AgentRunRecord[]> {
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const records: AgentRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const reportPath = path.join(this.runsDir, entry.name, "report.json");
      try {
        const raw = await readFile(reportPath, "utf8");
        records.push(JSON.parse(raw) as AgentRunRecord);
      } catch {
        // ignore
      }
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async inspect(id: string): Promise<AgentRunRecord> {
    const reportPath = path.join(this.runsDir, id, "report.json");
    const raw = await readFile(reportPath, "utf8");
    return JSON.parse(raw) as AgentRunRecord;
  }

  async approve(id: string): Promise<AgentRunRecord> {
    const record = await this.inspect(id);
    record.approved = true;
    await writeFile(record.reportPath, JSON.stringify(record, null, 2));
    const approvalLedger = new ExecutionLedger(record.ledgerPath); await approvalLedger.append("change_gate.approved", { approvedBy: "cli" });
    return record;
  }

  async replay(id: string): Promise<{ original: AgentRunRecord; replay: AgentRunRecord; stdoutMatch: boolean; fileManifestMatch: boolean }> {
    const original = await this.inspect(id);
    const replaySpec: AgentRunSpec = { ...original.spec, task: `${original.task} (replay)` };
    const replay = await this.run(replaySpec);
    return {
      original,
      replay,
      stdoutMatch: original.stdoutHash === replay.stdoutHash,
      fileManifestMatch: original.fileManifestHash === replay.fileManifestHash,
    };
  }

  private async computeFileManifest(root: string): Promise<string> {
    const files: string[] = [];
    await collectFiles(root, root, files);
    const entries: string[] = [];
    for (const rel of files.sort()) {
      const full = path.join(root, rel);
      const st = await stat(full);
      if (!st.isFile()) continue;
      const content = await readFile(full);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      entries.push(`${rel}\u0000${st.size}\u0000${hash}`);
    }
    return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
  }
}

async function collectFiles(root: string, current: string, out: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, out);
    else out.push(path.relative(root, full).replace(/\\/g, "/"));
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

