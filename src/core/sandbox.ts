import { spawn, execFile } from "node:child_process";
import {
  mkdir,
  rm,
  readdir,
  stat,
  writeFile,
  readFile,
  appendFile,
  lstat,
  realpath,
  rename,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import type {
  Sandbox,
  SandboxPolicy,
  RunOptions,
  RunResult,
  Snapshot,
  AuditEntry,
  ExecutionMode,
} from "./types.js";

const execFileAsync = promisify(execFile);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SandboxManagerOptions {
  baseDir?: string;
  allowHostCommands?: boolean;
}

function isWithin(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (process.platform === "win32") {
    const rl = r.toLowerCase();
    const tl = t.toLowerCase();
    const sep = path.sep.toLowerCase();
    return tl === rl || tl.startsWith(rl + sep);
  }
  return t === r || t.startsWith(r + path.sep);
}

async function realAncestor(p: string): Promise<{ real: string; missing: string[] }> {
  const missing: string[] = [];
  let current = path.resolve(p);
  while (true) {
    try {
      const rp = await realpath(current);
      return { real: rp, missing };
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`path does not exist and has no parent: ${p}`);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  return Promise.all(
    roots.map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return path.resolve(r);
      }
    })
  );
}

async function canonicalizePath(sbRoot: string, allowedPaths: string[], input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0) throw new Error("path is required");
  if (input.includes("\0")) throw new Error("path contains NUL byte");
  const roots = [sbRoot, ...allowedPaths];
  const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(sbRoot, input);

  if (!roots.some((r) => isWithin(r, resolved))) {
    throw new Error(`path outside sandbox/allowed paths: ${input}`);
  }

  const { real, missing } = await realAncestor(resolved);
  const cRoots = await canonicalRoots(roots);
  if (!cRoots.some((r) => isWithin(r, real))) {
    throw new Error(`path escapes sandbox via symlink: ${input}`);
  }

  // Reconstruct canonical path; missing segments are new path components.
  const canonical = path.join(real, ...missing);
  if (!cRoots.some((r) => isWithin(r, canonical))) {
    throw new Error(`path escapes sandbox: ${input}`);
  }

  // Reject existing symlink leaf.
  try {
    const st = await lstat(canonical);
    if (st.isSymbolicLink()) throw new Error(`symlink paths are not allowed: ${input}`);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  return canonical;
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32") {
      if (child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      }
    } else {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

async function validateArchiveEntries(archivePath: string): Promise<void> {
  const { stdout: namesOut } = await execFileAsync("tar", ["-tzf", archivePath], { timeout: 60000 });
  const { stdout: verboseOut } = await execFileAsync("tar", ["-tvzf", archivePath], { timeout: 60000 });
  const names = namesOut.split(/\r?\n/).filter((l) => l.length > 0);
  const verbose = verboseOut.split(/\r?\n/).filter((l) => l.length > 0);
  if (names.length !== verbose.length) {
    throw new Error("unable to parse snapshot archive");
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const type = verbose[i][0];
    if (type !== "-" && type !== "d") {
      throw new Error(`snapshot contains unsafe entry type: ${name}`);
    }
    const normalized = name.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error(`snapshot contains absolute path: ${name}`);
    }
    const segments = normalized.split("/").filter(Boolean);
    if (segments.includes("..")) {
      throw new Error(`snapshot contains path traversal: ${name}`);
    }
    if (name.includes("\\")) {
      throw new Error(`snapshot contains backslash path: ${name}`);
    }
  }
}

async function validateExtractedTree(root: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw new Error(`extracted symlink is not allowed: ${e.name}`);
      if (st.isDirectory()) await walk(full);
      else if (!st.isFile()) throw new Error(`extracted non-regular file is not allowed: ${e.name}`);
    }
  }
  await walk(root);
}

export class SandboxManager {
  private baseDir: string;
  private sandboxes = new Map<string, Sandbox>();
  private allowHostCommands: boolean;

  constructor(options: SandboxManagerOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? process.env.ENVIA_HOME ?? ".envia");
    this.allowHostCommands =
      options.allowHostCommands ??
      (process.env.ENVIA_ALLOW_HOST_COMMANDS === "1" ||
        process.env.ENVIA_ALLOW_HOST_COMMANDS === "true");
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    this.baseDir = await realpath(this.baseDir);
    await mkdir(path.join(this.baseDir, "sandboxes"), { recursive: true });
    await mkdir(path.join(this.baseDir, "snapshots"), { recursive: true });
    const dir = path.join(this.baseDir, "sandboxes");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!UUID_RE.test(e.name)) continue;
      const metaPath = path.join(dir, e.name, "sandbox.json");
      if (!existsSync(metaPath)) continue;
      try {
        const raw = await readFile(metaPath, "utf8");
        const sb = JSON.parse(raw) as Sandbox;
        if (
          sb &&
          sb.id === e.name &&
          sb.status === "active" &&
          typeof sb.rootDir === "string" &&
          isWithin(this.baseDir, sb.rootDir)
        ) {
          this.sandboxes.set(sb.id, sb);
        }
      } catch {
        // ignore corrupt metadata
      }
    }
  }

  get base(): string {
    return this.baseDir;
  }

  get hostCommandsEnabled(): boolean {
    return this.allowHostCommands;
  }

  async create(name: string, policy: Partial<SandboxPolicy> = {}): Promise<Sandbox> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("sandbox name is required");
    }
    if (name.length > 128) throw new Error("sandbox name is too long");

    const id = crypto.randomUUID();
    const rootDir = path.join(this.baseDir, "sandboxes", id);
    await mkdir(rootDir, { recursive: true });
    const realRoot = await realpath(rootDir);

    const fullPolicy: SandboxPolicy = {
      network: policy.network ?? false,
      allowedPaths: policy.allowedPaths ?? [],
      maxRuntimeMs: Math.min(Math.max(policy.maxRuntimeMs ?? 30000, 100), 300000),
      maxOutputBytes: Math.min(Math.max(policy.maxOutputBytes ?? 1_000_000, 1024), 10_000_000),
      maxFileBytes: Math.min(Math.max(policy.maxFileBytes ?? 1_000_000, 1), 50_000_000),
      maxSnapshotBytes: Math.min(Math.max(policy.maxSnapshotBytes ?? 100_000_000, 1024), 1_000_000_000),
      env: policy.env ?? {},
      allowHostCommands: policy.allowHostCommands ?? this.allowHostCommands,
    };

    const sb: Sandbox = {
      id,
      name: name.trim(),
      rootDir: realRoot,
      policy: fullPolicy,
      createdAt: new Date().toISOString(),
      status: "active",
    };
    await this.persist(sb);
    this.sandboxes.set(id, sb);
    await this.audit({ action: "sandbox.create", sandboxId: id, detail: { name: sb.name, policy: fullPolicy }, ok: true });
    return sb;
  }

  list(): Sandbox[] {
    return [...this.sandboxes.values()].filter((s) => s.status === "active");
  }

  get(id: string): Sandbox {
    if (!UUID_RE.test(id)) throw new Error(`invalid sandbox id: ${id}`);
    const sb = this.sandboxes.get(id);
    if (!sb || sb.status !== "active") throw new Error(`sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.get(id);
    try {
      await rm(sb.rootDir, { recursive: true, force: true });
    } catch (err) {
      await this.audit({ action: "sandbox.destroy", sandboxId: id, detail: {}, ok: false, error: String(err) });
      throw err;
    }
    this.sandboxes.delete(id);
    await this.audit({ action: "sandbox.destroy", sandboxId: id, detail: {}, ok: true });
  }

  async run(id: string, opts: RunOptions): Promise<RunResult> {
    const sb = this.get(id);
    if (!this.allowHostCommands || !sb.policy.allowHostCommands) {
      const err = new Error(
        "Host command execution is disabled by default. Set ENVIA_ALLOW_HOST_COMMANDS=1 and create a sandbox with allowHostCommands to enable trusted-host execution."
      );
      await this.audit({ action: "sandbox.run", sandboxId: id, detail: { command: opts?.command }, ok: false, error: err.message });
      throw err;
    }

    if (!opts || typeof opts.command !== "string" || opts.command.trim().length === 0) {
      throw new Error("command is required");
    }
    if (opts.command.includes("\0")) throw new Error("command contains NUL byte");
    const args = opts.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new Error("args must be an array of strings");
    }

    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? sb.policy.maxRuntimeMs, 100), 300000);
    const maxBytes = Math.min(Math.max(opts.maxOutputBytes ?? sb.policy.maxOutputBytes, 1024), 10_000_000);
    const cwd = opts.cwd ? await this.canonicalPath(sb, opts.cwd) : sb.rootDir;
    // Ensure cwd is a directory inside sandbox.
    const cwdStat = await lstat(cwd);
    if (!cwdStat.isDirectory()) throw new Error("cwd is not a directory");

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      ENVIA_NETWORK: sb.policy.network ? "enabled" : "disabled",
    };
    if (!sb.policy.network) {
      env.HTTP_PROXY = "http://127.0.0.1:1";
      env.HTTPS_PROXY = "http://127.0.0.1:1";
      env.NO_PROXY = "";
    }
    if (sb.policy.env) Object.assign(env, sb.policy.env);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (typeof v !== "string") throw new Error(`env value for ${k} must be a string`);
        if (this.isDangerousEnvKey(k)) throw new Error(`refusing dangerous env key: ${k}`);
        env[k] = v;
      }
    }

    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    await this.audit({
      action: "sandbox.run.start",
      sandboxId: id,
      detail: { command: opts.command, args, cwd, timeoutMs, maxBytes },
      ok: true,
    });

    const result = await new Promise<RunResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(opts.command, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (err) {
        resolve({
          sandboxId: id,
          command: opts.command,
          args,
          exitCode: null,
          signal: null,
          stdout,
          stderr: String(err),
          durationMs: Date.now() - start,
          timedOut: false,
          truncated: false,
          executionMode: "trusted-host",
        });
        return;
      }

      const finish = (partial: Partial<RunResult>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          sandboxId: id,
          command: opts.command,
          args,
          exitCode: partial.exitCode ?? null,
          signal: partial.signal ?? null,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut: partial.timedOut ?? timedOut,
          truncated,
          executionMode: "trusted-host",
        });
      };

      const append = (chunk: Buffer, kind: "out" | "err") => {
        const str = chunk.toString("utf8");
        if (kind === "out") {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= maxBytes) stdout += str;
          else {
            truncated = true;
            killTree(child);
          }
        } else {
          stderrBytes += chunk.length;
          if (stderrBytes <= maxBytes) stderr += str;
          else {
            truncated = true;
            killTree(child);
          }
        }
      };

      child.stdout?.on("data", (c: Buffer) => append(c, "out"));
      child.stderr?.on("data", (c: Buffer) => append(c, "err"));

      const timer = setTimeout(() => {
        timedOut = true;
        truncated = truncated || false;
        killTree(child);
      }, timeoutMs);

      child.on("error", (err) => {
        stderr += `\n[spawn error] ${err.message}`;
        finish({ exitCode: null, signal: null, timedOut: false });
      });

      child.on("close", (code, signal) => {
        finish({ exitCode: code, signal: signal ?? null, timedOut });
      });
    });

    // Ensure timedOut flag propagated (finish set it).
    if (timedOut) result.timedOut = true;

    await this.audit({
      action: "sandbox.run.finish",
      sandboxId: id,
      detail: {
        command: opts.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
      },
      ok: result.exitCode === 0 && !result.timedOut && !result.truncated,
    });
    return result;
  }

  private isDangerousEnvKey(key: string): boolean {
    const upper = key.toUpperCase();
    return (
      upper === "LD_PRELOAD" ||
      upper === "LD_LIBRARY_PATH" ||
      upper.startsWith("DYLD_") ||
      upper === "NODE_OPTIONS" ||
      upper === "PYTHONSTARTUP" ||
      upper === "BASH_ENV" ||
      upper === "ENV" ||
      upper === "PROMPT_COMMAND"
    );
  }

  async snapshot(id: string): Promise<Snapshot> {
    const sb = this.get(id);
    const snapId = crypto.randomUUID();
    const snapPath = path.join(this.baseDir, "snapshots", `${snapId}.tar.gz`);
    const tmpPath = path.join(this.baseDir, "snapshots", `.${snapId}.tar.gz.tmp`);

    try {
      await execFileAsync("tar", ["-czf", tmpPath, "-C", sb.rootDir, "."], { timeout: 120000 });
      await validateArchiveEntries(tmpPath);
      const st = await stat(tmpPath);
      if (st.size > sb.policy.maxSnapshotBytes) {
        throw new Error(`snapshot exceeds maximum size: ${st.size} > ${sb.policy.maxSnapshotBytes}`);
      }
      await rename(tmpPath, snapPath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      await this.audit({ action: "sandbox.snapshot", sandboxId: id, detail: { snapshotId: snapId }, ok: false, error: String(err) });
      throw err;
    }

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
      const metaPath = path.join(dir, f);
      try {
        const raw = await readFile(metaPath, "utf8");
        const snap = JSON.parse(raw) as Snapshot;
        if (snap && snap.sandboxId === id && UUID_RE.test(snap.id) && snap.path === path.join(dir, `${snap.id}.tar.gz`)) {
          out.push(snap);
        }
      } catch {
        // ignore corrupt metadata
      }
    }
    return out;
  }

  async restore(id: string, snapshotId: string): Promise<void> {
    const sb = this.get(id);
    if (!UUID_RE.test(snapshotId)) throw new Error(`invalid snapshot id: ${snapshotId}`);
    const metaPath = path.join(this.baseDir, "snapshots", `${snapshotId}.json`);
    const archivePath = path.join(this.baseDir, "snapshots", `${snapshotId}.tar.gz`);
    if (!existsSync(metaPath) || !existsSync(archivePath)) {
      throw new Error(`snapshot not found: ${snapshotId}`);
    }
    const archiveStat = await lstat(archivePath);
    if (!archiveStat.isFile()) throw new Error("snapshot archive is not a regular file");
    if (archiveStat.size > sb.policy.maxSnapshotBytes) {
      throw new Error(`snapshot exceeds maximum size: ${archiveStat.size} > ${sb.policy.maxSnapshotBytes}`);
    }

    // Validate metadata and ensure paths stay in snapshots dir.
    let snap: Snapshot;
    try {
      const raw = await readFile(metaPath, "utf8");
      snap = JSON.parse(raw) as Snapshot;
    } catch (err) {
      await this.audit({ action: "sandbox.restore", sandboxId: id, detail: { snapshotId }, ok: false, error: String(err) });
      throw new Error("corrupt snapshot metadata");
    }
    if (!snap || snap.id !== snapshotId || snap.sandboxId !== id || snap.path !== archivePath) {
      await this.audit({ action: "sandbox.restore", sandboxId: id, detail: { snapshotId }, ok: false, error: "metadata mismatch" });
      throw new Error("snapshot metadata mismatch");
    }

    try {
      await validateArchiveEntries(archivePath);
    } catch (err) {
      await this.audit({ action: "sandbox.restore", sandboxId: id, detail: { snapshotId }, ok: false, error: String(err) });
      throw err;
    }

    const stage = path.join(this.baseDir, "tmp", `restore-${crypto.randomUUID()}`);
    await mkdir(stage, { recursive: true });
    try {
      await execFileAsync("tar", ["-xzf", archivePath, "-C", stage], { timeout: 120000 });
      await validateExtractedTree(stage);

      // Clear current sandbox contents without following symlinks.
      const entries = await readdir(sb.rootDir);
      for (const e of entries) {
        const target = path.join(sb.rootDir, e);
        const st = await lstat(target);
        if (st.isSymbolicLink()) {
          await rm(target, { force: true });
        } else {
          await rm(target, { recursive: true, force: true });
        }
      }
      // Move staged contents into sandbox, preserving sandbox metadata.
      const staged = await readdir(stage);
      for (const e of staged) {
        if (e === "sandbox.json" || e === ".sandbox.json.tmp") {
          await rm(path.join(stage, e), { recursive: true, force: true });
          continue;
        }
        await rename(path.join(stage, e), path.join(sb.rootDir, e));
      }
    } catch (err) {
      await rm(stage, { recursive: true, force: true });
      await this.audit({ action: "sandbox.restore", sandboxId: id, detail: { snapshotId }, ok: false, error: String(err) });
      throw err;
    }
    await rm(stage, { recursive: true, force: true });
    await this.audit({ action: "sandbox.restore", sandboxId: id, detail: { snapshotId }, ok: true });
  }

  async canonicalPath(sb: Sandbox, p: string): Promise<string> {
    return canonicalizePath(sb.rootDir, sb.policy.allowedPaths, p);
  }

  // Synchronous path resolution is intentionally disabled because it cannot
  // resolve symlinks safely. Use canonicalPath() instead.
  resolveInSandbox(_sb: Sandbox, _p: string): string {
    throw new Error("synchronous path resolution is disabled; use canonicalPath()");
  }

  async writeFileInSandbox(id: string, relativePath: string, content: string): Promise<string> {
    const sb = this.get(id);
    try {
      if (typeof content !== "string") throw new Error("content must be a string");
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > sb.policy.maxFileBytes) {
        throw new Error(`content exceeds maximum file size: ${byteLength} > ${sb.policy.maxFileBytes}`);
      }
      const target = await this.canonicalPath(sb, relativePath);
      // Ensure parent exists and is inside sandbox.
      await mkdir(path.dirname(target), { recursive: true });
      // Re-canonicalize parent after mkdir to catch symlink races.
      const parent = await canonicalizePath(sb.rootDir, sb.policy.allowedPaths, path.dirname(relativePath));
      if (path.dirname(target) !== parent) {
        throw new Error("parent path changed during write");
      }
      try {
        const st = await lstat(target);
        if (st.isSymbolicLink()) throw new Error("refusing to write through symlink");
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
      await writeFile(target, content, "utf8");
      await this.audit({ action: "sandbox.writeFile", sandboxId: id, detail: { path: relativePath, bytes: byteLength }, ok: true });
      return target;
    } catch (err) {
      await this.audit({ action: "sandbox.writeFile", sandboxId: id, detail: { path: relativePath }, ok: false, error: String(err) });
      throw err;
    }
  }

  async readFileInSandbox(id: string, relativePath: string): Promise<string> {
    const sb = this.get(id);
    try {
      const target = await this.canonicalPath(sb, relativePath);
      try {
        const st = await lstat(target);
        if (st.isSymbolicLink()) throw new Error("refusing to read through symlink");
        if (!st.isFile()) throw new Error("not a regular file");
      } catch (err: any) {
        if (err?.code === "ENOENT") throw new Error(`file not found: ${relativePath}`);
        throw err;
      }
      const data = await readFile(target, "utf8");
      await this.audit({ action: "sandbox.readFile", sandboxId: id, detail: { path: relativePath, bytes: data.length }, ok: true });
      return data;
    } catch (err) {
      await this.audit({ action: "sandbox.readFile", sandboxId: id, detail: { path: relativePath }, ok: false, error: String(err) });
      throw err;
    }
  }

  async listFiles(id: string, relativePath = "."): Promise<string[]> {
    const sb = this.get(id);
    try {
      const target = await this.canonicalPath(sb, relativePath);
      const st = await lstat(target);
      if (st.isSymbolicLink()) throw new Error("refusing to list through symlink");
      if (!st.isDirectory()) throw new Error("not a directory");
      const entries = await readdir(target, { withFileTypes: true });
      const result = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
      await this.audit({ action: "sandbox.listFiles", sandboxId: id, detail: { path: relativePath, count: result.length }, ok: true });
      return result;
    } catch (err) {
      await this.audit({ action: "sandbox.listFiles", sandboxId: id, detail: { path: relativePath }, ok: false, error: String(err) });
      throw err;
    }
  }

  private async persist(sb: Sandbox): Promise<void> {
    const metaPath = path.join(sb.rootDir, "sandbox.json");
    const tmpPath = path.join(sb.rootDir, ".sandbox.json.tmp");
    await writeFile(tmpPath, JSON.stringify(sb, null, 2));
    await rename(tmpPath, metaPath);
  }

  private async audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    try {
      await appendFile(path.join(this.baseDir, "audit.log"), JSON.stringify(full) + "\n");
    } catch {
      // never fail a run because of audit
    }
  }

  async readAudit(limit = 100): Promise<AuditEntry[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    const capped = Math.min(limit, 10000);
    const p = path.join(this.baseDir, "audit.log");
    if (!existsSync(p)) return [];
    const raw = await readFile(p, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const parsed: AuditEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skip malformed audit lines
      }
    }
    return parsed.slice(-capped);
  }
}