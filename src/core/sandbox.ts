import { spawn } from "node:child_process";
import {
  mkdir,
  rm,
  readdir,
  stat,
  writeFile,
  readFile,
  appendFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Sandbox,
  SandboxPolicy,
  RunOptions,
  RunResult,
  Snapshot,
  AuditEntry,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface SandboxManagerOptions {
  baseDir?: string;
}

export class SandboxManager {
  private baseDir: string;
  private sandboxes = new Map<string, Sandbox>();

  constructor(options: SandboxManagerOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? process.env.ENVIA_HOME ?? ".envia");
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await mkdir(path.join(this.baseDir, "sandboxes"), { recursive: true });
    await mkdir(path.join(this.baseDir, "snapshots"), { recursive: true });
    // Load persisted sandboxes
    const dir = path.join(this.baseDir, "sandboxes");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(dir, e.name, "sandbox.json");
      if (!existsSync(metaPath)) continue;
      try {
        const raw = await readFile(metaPath, "utf8");
        const sb = JSON.parse(raw) as Sandbox;
        if (sb.status === "active") this.sandboxes.set(sb.id, sb);
      } catch {
        // ignore corrupt metadata
      }
    }
  }

  get base(): string {
    return this.baseDir;
  }

  async create(name: string, policy: Partial<SandboxPolicy> = {}): Promise<Sandbox> {
    if (!name || typeof name !== "string") throw new Error("sandbox name is required");
    const id = crypto.randomUUID();
    const rootDir = path.join(this.baseDir, "sandboxes", id);
    await mkdir(rootDir, { recursive: true });
    const fullPolicy: SandboxPolicy = {
      network: policy.network ?? false,
      allowedPaths: policy.allowedPaths ?? [],
      maxRuntimeMs: policy.maxRuntimeMs ?? 30000,
      maxOutputBytes: policy.maxOutputBytes ?? 1_000_000,
      env: policy.env ?? {},
    };
    const sb: Sandbox = {
      id,
      name,
      rootDir,
      policy: fullPolicy,
      createdAt: new Date().toISOString(),
      status: "active",
    };
    await this.persist(sb);
    this.sandboxes.set(id, sb);
    await this.audit({ action: "sandbox.create", sandboxId: id, detail: { name, policy: fullPolicy }, ok: true });
    return sb;
  }

  list(): Sandbox[] {
    return [...this.sandboxes.values()].filter((s) => s.status === "active");
  }

  get(id: string): Sandbox {
    const sb = this.sandboxes.get(id);
    if (!sb || sb.status !== "active") throw new Error(`sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.get(id);
    sb.status = "destroyed";
    await this.persist(sb);
    this.sandboxes.delete(id);
    await rm(sb.rootDir, { recursive: true, force: true });
    await this.audit({ action: "sandbox.destroy", sandboxId: id, detail: {}, ok: true });
  }

  async run(id: string, opts: RunOptions): Promise<RunResult> {
    const sb = this.get(id);
    if (!opts.command || typeof opts.command !== "string") throw new Error("command is required");
    const args = opts.args ?? [];
    const timeoutMs = Math.min(opts.timeoutMs ?? sb.policy.maxRuntimeMs ?? 30000, 300000);
    const maxBytes = opts.maxOutputBytes ?? sb.policy.maxOutputBytes ?? 1_000_000;
    const cwd = opts.cwd ? this.resolveInSandbox(sb, opts.cwd) : sb.rootDir;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(sb.policy.env ?? {}),
      ...(opts.env ?? {}),
    };
    if (!sb.policy.network) {
      // Best-effort: steer common HTTP clients away from the network.
      env.HTTP_PROXY = "http://127.0.0.1:1";
      env.HTTPS_PROXY = "http://127.0.0.1:1";
      env.NO_PROXY = "";
      env.ENVIA_NETWORK = "disabled";
    } else {
      env.ENVIA_NETWORK = "enabled";
    }

    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    await this.audit({ action: "sandbox.run.start", sandboxId: id, detail: { command: opts.command, args, cwd }, ok: true });

    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn(opts.command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
      });

      const append = (chunk: Buffer, kind: "out" | "err") => {
        const str = chunk.toString("utf8");
        if (kind === "out") {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= maxBytes) stdout += str;
          else truncated = true;
        } else {
          stderrBytes += chunk.length;
          if (stderrBytes <= maxBytes) stderr += str;
          else truncated = true;
        }
      };

      child.stdout?.on("data", (c: Buffer) => append(c, "out"));
      child.stderr?.on("data", (c: Buffer) => append(c, "err"));

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          sandboxId: id,
          command: opts.command,
          args,
          exitCode: null,
          signal: null,
          stdout,
          stderr: stderr + `\n[spawn error] ${err.message}`,
          durationMs: Date.now() - start,
          timedOut: false,
          truncated,
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          sandboxId: id,
          command: opts.command,
          args,
          exitCode: code,
          signal: signal ?? null,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
          truncated,
        });
      });
    });

    await this.audit({
      action: "sandbox.run.finish",
      sandboxId: id,
      detail: { command: opts.command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs },
      ok: result.exitCode === 0 && !result.timedOut,
    });
    return result;
  }

  async snapshot(id: string): Promise<Snapshot> {
    const sb = this.get(id);
    const snapId = crypto.randomUUID();
    const snapPath = path.join(this.baseDir, "snapshots", `${snapId}.tar.gz`);
    await execFileAsync("tar", ["-czf", snapPath, "-C", sb.rootDir, "."], { timeout: 120000 });
    const st = await stat(snapPath);
    const snap: Snapshot = {
      id: snapId,
      sandboxId: id,
      path: snapPath,
      createdAt: new Date().toISOString(),
      sizeBytes: st.size,
    };
    await writeFile(path.join(this.baseDir, "snapshots", `${snapId}.json`), JSON.stringify(snap, null, 2));
    await this.audit({ action: "sandbox.snapshot", sandboxId: id, detail: { snapshotId: snapId, sizeBytes: st.size }, ok: true });
    return snap;
  }

  async listSnapshots(id: string): Promise<Snapshot[]> {
    this.get(id);
    const dir = path.join(this.baseDir, "snapshots");
    const entries = await readdir(dir);
    const out: Snapshot[] = [];
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(dir, f), "utf8");
        const snap = JSON.parse(raw) as Snapshot;
        if (snap.sandboxId === id) out.push(snap);
      } catch { /* ignore */ }
    }
    return out;
  }

  async restore(id: string, snapshotId: string): Promise<void> {
    const sb = this.get(id);
    const metaPath = path.join(this.baseDir, "snapshots", `${snapshotId}.json`);
    if (!existsSync(metaPath)) throw new Error(`snapshot not found: ${snapshotId}`);
    const raw = await readFile(metaPath, "utf8");
    const snap = JSON.parse(raw) as Snapshot;
    if (snap.sandboxId !== id) throw new Error("snapshot does not belong to this sandbox");
    // Clear current contents
    const entries = await readdir(sb.rootDir);
    for (const e of entries) await rm(path.join(sb.rootDir, e), { recursive: true, force: true });
    await execFileAsync("tar", ["-xzf", snap.path, "-C", sb.rootDir], { timeout: 120000 });
    await this.audit({ action: "sandbox.restore", sandboxId: id, detail: { snapshotId }, ok: true });
  }

  resolveInSandbox(sb: Sandbox, p: string): string {
    const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(sb.rootDir, p);
    const root = path.resolve(sb.rootDir);
    const allowed = [root, ...(sb.policy.allowedPaths ?? []).map((x) => path.resolve(x))];
    const ok = allowed.some((a) => resolved === a || resolved.startsWith(a + path.sep));
    if (!ok) throw new Error(`path outside sandbox/allowed paths: ${p}`);
    return resolved;
  }

  async writeFileInSandbox(id: string, relativePath: string, content: string): Promise<string> {
    const sb = this.get(id);
    const target = this.resolveInSandbox(sb, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    await this.audit({ action: "sandbox.writeFile", sandboxId: id, detail: { path: relativePath, bytes: content.length }, ok: true });
    return target;
  }

  async readFileInSandbox(id: string, relativePath: string): Promise<string> {
    const sb = this.get(id);
    const target = this.resolveInSandbox(sb, relativePath);
    const data = await readFile(target, "utf8");
    await this.audit({ action: "sandbox.readFile", sandboxId: id, detail: { path: relativePath }, ok: true });
    return data;
  }

  async listFiles(id: string, relativePath = "."): Promise<string[]> {
    const sb = this.get(id);
    const target = this.resolveInSandbox(sb, relativePath);
    const entries = await readdir(target, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
  }

  private async persist(sb: Sandbox): Promise<void> {
    const metaPath = path.join(sb.rootDir, "sandbox.json");
    // rootDir may not exist for destroyed; guard
    try { await mkdir(sb.rootDir, { recursive: true }); } catch { /* ignore */ }
    await writeFile(metaPath, JSON.stringify(sb, null, 2));
  }

  private async audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    try {
      await appendFile(path.join(this.baseDir, "audit.log"), JSON.stringify(full) + "\n");
    } catch { /* never fail a run because of audit */ }
  }

  async readAudit(limit = 100): Promise<AuditEntry[]> {
    const p = path.join(this.baseDir, "audit.log");
    if (!existsSync(p)) return [];
    const raw = await readFile(p, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as AuditEntry);
    return parsed.slice(-limit);
  }
}