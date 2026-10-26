import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdir, rm, readFile, writeFile, cp, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimeBackend, CapabilityMatrix, JailSpec, JailRecord } from "../types.js";

const execFileAsync = promisify(execFile);

import { NetworkManager } from "../../network/manager.js";

export interface LinuxNamespaceBackendOptions {
  baseDir: string;
  allowUnsafe?: boolean;
  networkManager?: NetworkManager;
}

export class LinuxNamespaceBackend implements RuntimeBackend {
  readonly name = "linux-namespace";
  private baseDir: string;
  private allowUnsafe: boolean;
  private networkManager?: NetworkManager;
  private processes = new Map<string, number>();
  private exitCodes = new Map<string, number | null>();
  private cgroupPaths = new Map<string, string>();
  private networkAttachments = new Map<string, string[]>();

  constructor(options: LinuxNamespaceBackendOptions) {
    this.baseDir = options.baseDir;
    this.allowUnsafe = options.allowUnsafe ?? false;
    this.networkManager = options.networkManager;
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
    const unshareAvailable = linux && this.commandExistsSync("unshare") && this.commandExistsSync("mount");
    const isolation = linux && unshareAvailable ? "enforced" : "unsupported";
    const network = linux && unshareAvailable && this.commandExistsSync("ip") && this.hasCapNetAdmin() ? "enforced" : "unsupported";
    const resourceLimits = linux && unshareAvailable && this.cgroupAvailable() ? "enforced" : "unsupported";
    return {
      isolation,
      network,
      resourceLimits,
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

  private hasCapNetAdmin(): boolean {
    try {
      const status = require("node:fs").readFileSync("/proc/self/status", "utf8");
      const match = status.match(/^CapEff:\s*([0-9a-f]+)$/m);
      if (!match) return false;
      const caps = BigInt(`0x${match[1]}`);
      return (caps & (1n << 12n)) !== 0n;
    } catch {
      return false;
    }
  }

  private cgroupAvailable(): boolean {
    try {
      const root = "/sys/fs/cgroup";
      const fs = require("node:fs");
      if (!fs.existsSync(`${root}/cgroup.controllers`)) return false;
      const testDir = `${root}/envia-capability-test`;
      fs.mkdirSync(testDir, { recursive: true });
      fs.rmdirSync(testDir);
      return true;
    } catch {
      return false;
    }
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
    if ((spec.networkMode ?? "none") === "bridge" && !(spec.networks && spec.networks.length)) {
      throw new Error("bridge network mode requires at least one network");
    }
    if (spec.limits && (spec.limits.cpuMillis || spec.limits.memoryBytes || spec.limits.pids || spec.limits.runtimeMs) && !this.cgroupAvailable()) {
      throw new Error("requested resource limits require cgroups v2, which is unavailable");
    }

    const id = crypto.randomUUID();
    const rootDir = path.join(this.baseDir, "runtime", "jails", id);
    const logPath = path.join(rootDir, "jail.log");
    await mkdir(rootDir, { recursive: true });

    let cgroupPath: string | undefined;
    if (spec.limits && (spec.limits.cpuMillis || spec.limits.memoryBytes || spec.limits.pids || spec.limits.runtimeMs)) {
      cgroupPath = `/sys/fs/cgroup/envia/${id}`;
      await mkdir(cgroupPath, { recursive: true });
      if (spec.limits.memoryBytes) await writeFile(`${cgroupPath}/memory.max`, String(spec.limits.memoryBytes));
      if (spec.limits.pids) await writeFile(`${cgroupPath}/pids.max`, String(spec.limits.pids));
      if (spec.limits.cpuMillis) {
        const quota = Math.max(1000, spec.limits.cpuMillis * 100);
        await writeFile(`${cgroupPath}/cpu.max`, `${quota} 100000`);
      }
      this.cgroupPaths.set(id, cgroupPath);
    }

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
mkdir -p "$ROOTFS/oldroot"
mount --make-rprivate "$ROOTFS" || true
mount --bind "$ROOTFS" "$ROOTFS"
mkdir -p "$ROOTFS/proc" "$ROOTFS/dev" "$ROOTFS/tmp"
mount -t proc proc "$ROOTFS/proc" || true
for devnode in null zero random urandom tty; do
  if [ -e "/dev/$devnode" ]; then
    touch "$ROOTFS/dev/$devnode"
    mount --bind "/dev/$devnode" "$ROOTFS/dev/$devnode" || true
  fi
done
mount --make-rslave "$ROOTFS/dev" 2>/dev/null || true
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
    if (netMode === "none" || netMode === "bridge") args.push("--net");
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
    if (!child.pid) {
      void logFd.close().catch(() => undefined);
      throw new Error("failed to spawn isolation process");
    }
    this.processes.set(jail.id, child.pid);
    this.exitCodes.set(jail.id, null);

    // Detect immediate failure.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessAlive(child.pid)) {
      const code = this.exitCodes.get(jail.id) ?? null;
      void logFd.close().catch(() => undefined);
      throw new Error(`isolation process exited immediately with code ${code}`);
    }

    const cgroupPath = this.cgroupPaths.get(jail.id);
    if (cgroupPath) {
      try {
        await writeFile(`${cgroupPath}/cgroup.procs`, String(child.pid));
      } catch (err) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
        void logFd.close().catch(() => undefined);
        throw new Error(`failed to assign process to cgroup: ${String(err)}`);
      }
    }

    // Attach bridge networks.
    const attachments: string[] = [];
    if (netMode === "bridge" && this.networkManager) {
      for (const networkName of jail.spec.networks ?? []) {
        try {
          await this.networkManager.attachJail(networkName, jail.id, child.pid);
          attachments.push(networkName);
          const allocation = await this.networkManager.findAllocation(networkName, jail.id);
          for (const port of jail.spec.publishedPorts ?? []) {
            if (allocation?.ip) {
              await this.networkManager.publishPort(Number(port.hostPort), allocation.ip, Number(port.containerPort), port.protocol ?? "tcp");
            }
          }
        } catch (err) {
          for (const attached of attachments) await this.networkManager.detachJail(attached, jail.id).catch(() => undefined);
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
          void logFd.close().catch(() => undefined);
          throw new Error(`failed to attach network ${networkName}: ${String(err)}`);
        }
      }
    }
    this.networkAttachments.set(jail.id, attachments);

    child.on("exit", (code) => {
      this.exitCodes.set(jail.id, code);
      this.processes.delete(jail.id);
      jail.exitCode = code;
      jail.pid = null;
      void logFd.close().catch(() => undefined);
    });
    child.on("error", (err) => {
      this.exitCodes.set(jail.id, null);
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
    for (const network of this.networkAttachments.get(jail.id) ?? []) {
      await this.networkManager?.detachJail(network, jail.id).catch(() => undefined);
    }
    this.networkAttachments.delete(jail.id);

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

    const cgroupPath = this.cgroupPaths.get(jail.id);
    if (cgroupPath) {
      await rm(cgroupPath, { recursive: true, force: true }).catch(() => undefined);
      this.cgroupPaths.delete(jail.id);
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
    if (process.platform !== "linux") throw new Error("linux-namespace backend requires Linux");
    if (!this.commandExistsSync("nsenter")) throw new Error("exec requires the 'nsenter' utility");
    const pid = this.processes.get(jail.id) ?? jail.pid ?? undefined;
    if (!pid || !isProcessAlive(pid)) throw new Error(`jail is not running: ${jail.id}`);

    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? jail.spec.limits?.runtimeMs ?? 120000, 100), 300000);
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    const wd = (jail.spec.workingDirectory ?? "/").replace(/^\/+/, "");
    const fullWd = wd ? `/${wd}` : "/";
    const started = Date.now();
    let timedOut = false;

    const nsenterArgs = [
      "-t", String(pid),
      "-m", "-u", "-i", "-n", "-p",
      "--",
      "/bin/sh", "-c",
      'cd -- "$1"; shift; exec "$@"',
      "envia-exec",
      fullWd,
      command,
      ...args,
    ];

    return await new Promise((resolve) => {
      const child = spawn("nsenter", nsenterArgs, {
        env: { ...process.env, ...(jail.spec.env ?? {}), ...(options.env ?? {}) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutputBytes) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutputBytes) stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${String(err)}`.trim(), durationMs: Date.now() - started, timedOut });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const cgroupPath = this.cgroupPaths.get(jail.id);
        if (cgroupPath && child.pid) {
          void writeFile(`${cgroupPath}/cgroup.procs`, String(child.pid)).catch(() => undefined);
        }
        resolve({ exitCode: code, signal: signal ?? null, stdout, stderr, durationMs: Date.now() - started, timedOut });
      });
    });
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
