import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdir, rm, readFile, writeFile, cp, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimeBackend, CapabilityMatrix, JailSpec, JailRecord } from "../types.js";

const execFileAsync = promisify(execFile);

export interface LinuxNamespaceBackendOptions {
  baseDir: string;
  allowUnsafe?: boolean;
}

export class LinuxNamespaceBackend implements RuntimeBackend {
  readonly name = "linux-namespace";
  private baseDir: string;
  private allowUnsafe: boolean;
  private processes = new Map<string, number>();
  private exitCodes = new Map<string, number | null>();

  constructor(options: LinuxNamespaceBackendOptions) {
    this.baseDir = options.baseDir;
    this.allowUnsafe = options.allowUnsafe ?? false;
  }

  static isSupported(): { supported: boolean; reason?: string } {
    if (process.platform !== "linux") {
      return { supported: false, reason: `linux-namespace backend requires Linux; current platform is ${process.platform}` };
    }
    // Detection is performed lazily for binaries; constructor does not throw.
    return { supported: true };
  }

  capabilities(): CapabilityMatrix {
    const linux = process.platform === "linux";
    const unshareAvailable = linux && this.commandExistsSync("unshare");
    const enforced = linux && unshareAvailable;
    return {
      isolation: enforced ? "enforced" : "unsupported",
      network: enforced ? "best-effort" : "unsupported",
      resourceLimits: enforced ? "best-effort" : "unsupported",
      interactiveTerminal: false,
      pauseResume: false,
      checkpoint: false,
    };
  }

  private resolveInside(rootDir: string, target: string): string {
    const cleaned = target.replace(/^\/+/, "");
    const resolved = path.resolve(rootDir, cleaned);
    if (!resolved.startsWith(rootDir)) throw new Error("mount target escapes jail root");
    return resolved;
  }

  private commandExistsSync(command: string): boolean {
    try {
      const result = execFileSync("command", ["-v", command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async createJail(spec: JailSpec): Promise<JailRecord> {
    if (process.platform !== "linux") {
      throw new Error(`linux-namespace backend requires Linux; current platform is ${process.platform}`);
    }
    if (!this.commandExistsSync("unshare")) {
      throw new Error("linux-namespace backend requires the 'unshare' utility");
    }
    if (!this.commandExistsSync("mount")) {
      throw new Error("linux-namespace backend requires the 'mount' utility");
    }
    if (spec.isolationRequired === false && !this.allowUnsafe) {
      // Isolation is the purpose of this backend; still allow explicit unsafe for tests.
    }

    const id = crypto.randomUUID();
    const rootDir = path.join(this.baseDir, "runtime", "jails", id);
    const logPath = path.join(rootDir, "jail.log");
    await mkdir(rootDir, { recursive: true });
    if (spec.rootfsPath) {
      await cp(spec.rootfsPath, rootDir, { recursive: true, force: true });
    }
    for (const mount of spec.mounts ?? []) {
      const target = this.resolveInside(rootDir, mount.target);
      await mkdir(path.dirname(target), { recursive: true });
      await (await import("node:fs/promises")).rm(target, { recursive: true, force: true }).catch(() => undefined);
      const st = await (await import("node:fs/promises")).stat(mount.source);
      if (st.isDirectory()) {
        await (await import("node:fs/promises")).symlink(mount.source, target, "dir");
      } else {
        await (await import("node:fs/promises")).link(mount.source, target);
      }
    }

    const launcherPath = path.join(rootDir, ".envia-launch.sh");
    const wd = (spec.workingDirectory ?? "/").replace(/^\/+/, "") || "";
    const memoryKb = spec.limits?.memoryBytes ? Math.max(1, Math.floor(spec.limits.memoryBytes / 1024)) : 0;
    const pids = spec.limits?.pids ?? 0;
    const timeoutSec = spec.limits?.runtimeMs ? Math.max(1, Math.ceil(spec.limits.runtimeMs / 1000)) : 0;
    const netMode = spec.networkMode ?? "none";
    const launcher = `#!/bin/sh
set -e
ROOTFS=${shellQuote(rootDir)}
WD=${shellQuote(wd ? `/${wd}` : "/")}
CMD=${shellQuote(spec.command)}
${memoryKb ? `ulimit -v ${memoryKb} || true` : ""}
${pids ? `ulimit -u ${pids} || true` : ""}
${timeoutSec ? `ulimit -t ${timeoutSec} || true` : ""}
mkdir -p "$ROOTFS/oldroot"
mount --bind "$ROOTFS" "$ROOTFS"
mkdir -p "$ROOTFS/proc" "$ROOTFS/dev" "$ROOTFS/tmp"
mount -t proc proc "$ROOTFS/proc" || true
mount --rbind /dev "$ROOTFS/dev" || true
mount --make-rslave "$ROOTFS/dev" || true
pivot_root "$ROOTFS" "$ROOTFS/oldroot"
cd /
umount -l /oldroot || true
rmdir /oldroot 2>/dev/null || true
mkdir -p "$WD"
cd "$WD"
exec "$CMD" "$@"
`;
    await writeFile(launcherPath, launcher, { mode: 0o700 });

    const now = new Date().toISOString();
    return {
      id,
      name: spec.name,
      backend: this.name,
      spec: { ...spec, networkMode: netMode },
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
    const netMode = jail.spec.networkMode ?? "none";
    const args = ["--user", "--mount", "--pid", "--fork", "--uts", "--ipc"];
    if (netMode === "none") args.push("--net");
    args.push("--map-root-user");
    args.push("/bin/sh", path.join(jail.rootDir, ".envia-launch.sh"), ...(jail.spec.args ?? []));

    const logFd = await open(jail.logPath, "a");
    const child = spawn("unshare", args, {
      cwd: jail.rootDir,
      env: { ...process.env, ...(jail.spec.env ?? {}) },
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      windowsHide: true,
    });
    if (child.pid) {
      this.processes.set(jail.id, child.pid);
      this.exitCodes.set(jail.id, null);
    }
    child.on("exit", (code) => {
      this.exitCodes.set(jail.id, code);
      this.processes.delete(jail.id);
      jail.exitCode = code;
      jail.pid = null;
      void logFd.close().catch(() => undefined);
    });
    child.on("error", () => {
      this.processes.delete(jail.id);
      jail.pid = null;
      void logFd.close().catch(() => undefined);
    });

    const now = new Date().toISOString();
    return { ...jail, state: "running", startedAt: now, updatedAt: now, pid: child.pid ?? null };
  }

  async inspectJail(jail: JailRecord): Promise<JailRecord> {
    const pid = this.processes.get(jail.id) ?? jail.pid ?? undefined;
    if (pid && !isProcessAlive(pid)) {
      this.processes.delete(jail.id);
      const exitCode = this.exitCodes.get(jail.id) ?? jail.exitCode ?? null;
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
        process.kill(-pid, "SIGTERM");
      } catch {
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 1000)));
      if (isProcessAlive(pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch {
          try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
        }
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

  async execJail(jail: JailRecord, command: string, args: string[] = [], options: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> } = {}): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
    // exec into a namespace backend requires nsenter; report unsupported clearly.
    throw new Error("exec is not implemented for linux-namespace backend in this version; use host-process backend or extend with nsenter");
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
