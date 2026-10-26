import { spawn } from "node:child_process";
import { mkdir, rm, readFile, cp, symlink, stat, link } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  RuntimeBackend,
  CapabilityMatrix,
  JailSpec,
  JailRecord,
} from "../types.js";

export interface HostProcessBackendOptions {
  baseDir: string;
  allowUnsafeHostProcess?: boolean;
}

export class HostProcessBackend implements RuntimeBackend {
  readonly name = "host-process";
  private baseDir: string;
  private allowUnsafe: boolean;
  private processes = new Map<string, number>();
  private exitCodes = new Map<string, number | null>();

  constructor(options: HostProcessBackendOptions) {
    this.baseDir = options.baseDir;
    this.allowUnsafe = options.allowUnsafeHostProcess ?? false;
  }

  capabilities(): CapabilityMatrix {
    return {
      isolation: "unsupported",
      network: "unsupported",
      resourceLimits: "best-effort",
      interactiveTerminal: false,
      pauseResume: false,
      checkpoint: false,
    };
  }

  async createJail(spec: JailSpec): Promise<JailRecord> {
    if (!this.allowUnsafe && spec.allowUnsafeHostProcess !== true) {
      throw new Error(
        "host-process backend requires an explicit unsafe override: set allowUnsafeHostProcess or ENVIA_ALLOW_HOST_PROCESS_BACKEND=1"
      );
    }
    if (spec.isolationRequired !== false) {
      throw new Error("host-process backend cannot satisfy isolationRequired=true");
    }
    const id = crypto.randomUUID();
    const rootDir = path.join(this.baseDir, "runtime", "jails", id);
    const logPath = path.join(rootDir, "jail.log");
    await mkdir(rootDir, { recursive: true });
    if (spec.rootfsPath) {
      await cp(spec.rootfsPath, rootDir, { recursive: true, force: true });
    }
    const now = new Date().toISOString();
    return {
      id,
      name: spec.name,
      backend: this.name,
      spec,
      state: "created",
      createdAt: now,
      updatedAt: now,
      pid: null,
      exitCode: null,
      rootDir,
      logPath,
    };
  }

  async startJail(jail: JailRecord): Promise<JailRecord> {
    const wd = (jail.spec.workingDirectory ?? "").replace(/^\/+/, "");
    const cwd = wd ? path.resolve(jail.rootDir, wd) : jail.rootDir;
    if (!cwd.startsWith(jail.rootDir)) {
      throw new Error("working directory escapes jail root");
    }
    await this.applyMounts(jail);
    const logFd = openSync(jail.logPath, "a");
    const child = spawn(jail.spec.command, jail.spec.args ?? [], {
      cwd,
      env: { ...process.env, ...(jail.spec.env ?? {}) },
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    if (child.pid) this.processes.set(jail.id, child.pid);
    this.exitCodes.set(jail.id, null);
    child.on("exit", (code) => {
      this.exitCodes.set(jail.id, code);
      this.processes.delete(jail.id);
      jail.exitCode = code;
      jail.pid = null;
      // Do not close logFd immediately; allow stdio buffers to flush.
    });
    child.on("error", (err) => {
      this.exitCodes.set(jail.id, null);
      this.processes.delete(jail.id);
      jail.pid = null;
    });
    const now = new Date().toISOString();
    return { ...jail, state: "running", startedAt: now, updatedAt: now, pid: child.pid ?? null };
  }

  async inspectJail(jail: JailRecord): Promise<JailRecord> {
    const pid = this.processes.get(jail.id) ?? jail.pid ?? undefined;
    if (pid && !isProcessAlive(pid)) {
      this.processes.delete(jail.id);
      const exitCode = this.exitCodes.has(jail.id) ? this.exitCodes.get(jail.id) ?? null : jail.exitCode ?? null;
      return { ...jail, state: "stopped", pid: null, exitCode, updatedAt: new Date().toISOString() };
    }
    return jail;
  }

  async listJails(): Promise<JailRecord[]> {
    return [];
  }

  async stopJail(jail: JailRecord, timeoutMs = 5000): Promise<JailRecord> {
    const pid = this.processes.get(jail.id) ?? jail.pid ?? undefined;
    if (pid) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            process.kill(pid, "SIGKILL");
          }
        }
      } catch {
        // ignore
      }
      this.processes.delete(jail.id);
    }
    // Wait briefly for the process to release file handles.
    if (pid) {
      const deadline = Date.now() + timeoutMs;
      while (isProcessAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const now = new Date().toISOString();
    return { ...jail, state: "stopped", pid: null, stoppedAt: now, updatedAt: now };
  }

  async removeJail(jail: JailRecord): Promise<void> {
    if (jail.state === "running") await this.stopJail(jail);
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await rm(jail.rootDir, { recursive: true, force: true });
        return;
      } catch (err: any) {
        if (err?.code !== "EBUSY" && err?.code !== "EPERM") throw err;
        // Re-attempt process cleanup in case a descendant survived.
        try {
          if (process.platform === "win32") spawn("taskkill", ["/IM", "timeout.exe", "/F"], { windowsHide: true });
        } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await rm(jail.rootDir, { recursive: true, force: true });
  }

  async execJail(jail: JailRecord, command: string, args: string[] = [], options: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> } = {}): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? jail.spec.limits?.runtimeMs ?? 120000, 100), 300000);
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    const cwd = jail.spec.workingDirectory
      ? path.resolve(jail.rootDir, jail.spec.workingDirectory.replace(/^\/+/, ""))
      : jail.rootDir;
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(jail.spec.env ?? {}), ...(options.env ?? {}) },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* ignore */ }
        try { killTree(child); } catch { /* ignore */ }
      }, timeoutMs);
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString();
        if (target === "stdout") {
          if (stdout.length < maxOutputBytes) stdout += text;
          else truncated = true;
        } else {
          if (stderr.length < maxOutputBytes) stderr += text;
          else truncated = true;
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          signal: null,
          stdout,
          stderr: `${stderr}\n${String(err)}`.trim(),
          durationMs: Date.now() - started,
          timedOut,
        });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal: signal ?? null,
          stdout: truncated ? `${stdout}\n[output truncated]` : stdout,
          stderr: truncated ? `${stderr}\n[output truncated]` : stderr,
          durationMs: Date.now() - started,
          timedOut,
        });
      });
    });
  }

  private async applyMounts(jail: JailRecord): Promise<void> {
    for (const mount of jail.spec.mounts ?? []) {
      const target = this.resolveMountTarget(jail.rootDir, mount.target);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await rm(target, { recursive: true, force: true });
      } catch {
        // ignore
      }
      const st = await stat(mount.source);
      if (st.isDirectory()) {
        const type = process.platform === "win32" ? "junction" : "dir";
        await symlink(mount.source, target, type as any);
      } else {
        await link(mount.source, target);
      }
    }
  }

  private resolveMountTarget(rootDir: string, target: string): string {
    const cleaned = target.replace(/^\/+/, "");
    const resolved = path.resolve(rootDir, cleaned);
    if (!resolved.startsWith(rootDir)) throw new Error("mount target escapes jail root");
    return resolved;
  }

  async logs(jail: JailRecord, lines = 100): Promise<string[]> {
    try {
      const raw = await readFile(jail.logPath, "utf8");
      return raw.split(/\r?\n/).filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32") {
      if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}