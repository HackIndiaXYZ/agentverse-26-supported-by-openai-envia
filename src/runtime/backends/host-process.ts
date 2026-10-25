import { spawn } from "node:child_process";
import { mkdir, rm, readFile } from "node:fs/promises";
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
    const cwd = jail.spec.workingDirectory
      ? path.resolve(jail.rootDir, jail.spec.workingDirectory)
      : jail.rootDir;
    if (!cwd.startsWith(jail.rootDir)) {
      throw new Error("working directory escapes jail root");
    }
    const logFd = openSync(jail.logPath, "a");
    const child = spawn(jail.spec.command, jail.spec.args ?? [], {
      cwd,
      env: { ...process.env, ...(jail.spec.env ?? {}) },
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    if (child.pid) this.processes.set(jail.id, child.pid);
    child.on("exit", (code) => {
      jail.exitCode = code;
      jail.pid = null;
      try { closeSync(logFd); } catch { /* ignore */ }
    });
    child.on("error", () => {
      try { closeSync(logFd); } catch { /* ignore */ }
    });
    const now = new Date().toISOString();
    return { ...jail, state: "running", startedAt: now, updatedAt: now, pid: child.pid ?? null };
  }

  async inspectJail(jail: JailRecord): Promise<JailRecord> {
    const pid = this.processes.get(jail.id) ?? jail.pid ?? undefined;
    if (pid && !isProcessAlive(pid)) {
      this.processes.delete(jail.id);
      return { ...jail, state: "stopped", pid: null, updatedAt: new Date().toISOString() };
    }
    return jail;
  }

  async listJails(): Promise<JailRecord[]> {
    return [];
  }

  async stopJail(jail: JailRecord, _timeoutMs = 5000): Promise<JailRecord> {
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
    const now = new Date().toISOString();
    return { ...jail, state: "stopped", pid: null, stoppedAt: now, updatedAt: now };
  }

  async removeJail(jail: JailRecord): Promise<void> {
    if (jail.state === "running") await this.stopJail(jail);
    await rm(jail.rootDir, { recursive: true, force: true });
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}