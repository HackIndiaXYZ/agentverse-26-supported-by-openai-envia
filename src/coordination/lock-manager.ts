import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface LockHandle {
  resource: string;
  lockPath: string;
  token: string;
  release(): Promise<void>;
}

export class LockManager {
  private baseDir: string;
  private locksDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.locksDir = path.join(baseDir, "locks");
  }

  async init(): Promise<void> {
    await mkdir(this.locksDir, { recursive: true });
  }

  private lockPath(resource: string): string {
    const safe = resource.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.locksDir, `${safe}-${crypto.createHash("sha256").update(resource).digest("hex").slice(0, 12)}.lock`);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async acquire(resource: string, timeoutMs = 10000): Promise<LockHandle> {
    const lockPath = this.lockPath(resource);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const token = crypto.randomUUID();
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        const handle = await (await import("node:fs/promises")).open(lockPath, "wx");
        const metadata = { resource, ownerPid: process.pid, ownerToken: token, acquiredAt: new Date().toISOString() };
        await handle.writeFile(JSON.stringify(metadata));
        await handle.sync().catch(() => undefined);
        await handle.close();
        return {
          resource,
          lockPath,
          token,
          release: async () => {
            try {
              const raw = await readFile(lockPath, "utf8");
              const parsed = JSON.parse(raw);
              if (parsed.ownerToken === token && parsed.ownerPid === process.pid) await unlink(lockPath).catch(() => undefined);
            } catch {
              // Lock metadata is missing or corrupt; do not delete another owner's lock.
            }
          },
        };
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;

        let stale = false;
        try {
          const raw = await readFile(lockPath, "utf8");
          const parsed = JSON.parse(raw);
          if (typeof parsed.ownerPid === "number" && !this.isProcessAlive(parsed.ownerPid)) stale = true;
        } catch {
          // Corrupt metadata cannot prove ownership; leave it for manual recovery.
          stale = false;
        }

        if (stale) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`resource is busy: ${resource}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  async withLock<T>(resource: string, fn: () => Promise<T>, timeoutMs = 10000): Promise<T> {
    const lock = await this.acquire(resource, timeoutMs);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}