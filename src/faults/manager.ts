import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Jailor } from "../runtime/jailor.js";

export type FaultType =
  | "process-terminate"
  | "timeout"
  | "cpu-pressure"
  | "memory-pressure"
  | "pid-exhaustion"
  | "dependency-unavailable"
  | "network-block";

export interface FaultRecord {
  id: string;
  experimentId: string;
  type: FaultType;
  target: string;
  params: Record<string, unknown>;
  supported: boolean;
  applied: boolean;
  startedAt: string;
  endedAt?: string;
  cleanupOutcome: "success" | "failed" | "not-needed";
  notes: string;
}

export interface FaultCapability {
  type: FaultType;
  support: "supported" | "best-effort" | "unsupported";
  requirements: string;
}

export class FaultManager {
  private baseDir: string;
  private jailor: Jailor;

  constructor(baseDir: string, jailor: Jailor) {
    this.baseDir = baseDir;
    this.jailor = jailor;
  }

  capabilities(): FaultCapability[] {
    return [
      { type: "process-terminate", support: "supported", requirements: "Running jail with a tracked process" },
      { type: "timeout", support: "supported", requirements: "exec timeout support" },
      { type: "cpu-pressure", support: "best-effort", requirements: "A shell available in the jail; limits are best-effort unless cgroups are enforced" },
      { type: "memory-pressure", support: "best-effort", requirements: "A shell available in the jail; memory limits must be enforced by the backend" },
      { type: "pid-exhaustion", support: "best-effort", requirements: "PID limits enforced by the backend" },
      { type: "dependency-unavailable", support: "supported", requirements: "None" },
      { type: "network-block", support: "unsupported", requirements: "Linux bridge networking, iptables, and CAP_NET_ADMIN" },
    ];
  }

  async faultsPath(experimentId: string): Promise<string> {
    const dir = path.join(this.baseDir, "experiments", experimentId);
    await mkdir(dir, { recursive: true });
    return path.join(dir, "faults.json");
  }

  async readFaults(experimentId: string): Promise<FaultRecord[]> {
    try {
      const raw = await readFile(await this.faultsPath(experimentId), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async applyFault(experimentId: string, jailId: string, type: FaultType, params: Record<string, unknown> = {}): Promise<FaultRecord> {
    const record: FaultRecord = {
      id: crypto.randomUUID(),
      experimentId,
      type,
      target: jailId,
      params,
      supported: this.isSupported(type),
      applied: false,
      startedAt: new Date().toISOString(),
      cleanupOutcome: "not-needed",
      notes: "",
    };

    const faults = await this.readFaults(experimentId);
    faults.push(record);
    await writeFile(await this.faultsPath(experimentId), JSON.stringify(faults, null, 2));

    if (!record.supported) {
      record.notes = "Fault type is not supported by the current backend";
      record.endedAt = new Date().toISOString();
      await this.persist(experimentId, faults);
      return record;
    }

    try {
      switch (type) {
        case "process-terminate": {
          await this.jailor.stopJail(jailId);
          record.applied = true;
          record.cleanupOutcome = "success";
          record.notes = "Jail process tree terminated";
          break;
        }
        case "timeout": {
          const timeoutMs = Number(params.timeoutMs ?? 1000);
          await this.jailor.execJail(jailId, process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", "timeout", "/t", "10", "/nobreak"] : ["-c", "sleep 10"], { timeoutMs });
          record.applied = true;
          record.cleanupOutcome = "success";
          record.notes = "Execution timed out as requested";
          break;
        }
        case "cpu-pressure": {
          const durationMs = Math.min(Number(params.durationMs ?? 1000), 10000);
          await this.jailor.execJail(jailId, process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", "timeout", "/t", String(Math.ceil(durationMs / 1000)), "/nobreak"] : ["-c", `end=$((SECONDS+${Math.ceil(durationMs / 1000)})); while [ $SECONDS -lt $end ]; do :; done`], { timeoutMs: durationMs + 1000 });
          record.applied = true;
          record.cleanupOutcome = "success";
          record.notes = "Bounded CPU pressure applied";
          break;
        }
        case "memory-pressure": {
          record.notes = "Memory-pressure fault is best-effort and requires a suitable allocator in the jail";
          record.applied = false;
          record.cleanupOutcome = "not-needed";
          break;
        }
        case "pid-exhaustion": {
          record.notes = "PID-exhaustion fault requires backend-enforced PID limits and a suitable shell";
          record.applied = false;
          record.cleanupOutcome = "not-needed";
          break;
        }
        case "dependency-unavailable": {
          const result = await this.jailor.execJail(jailId, process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", "definitely-missing-envia-dependency"] : ["-c", "definitely-missing-envia-dependency"], { timeoutMs: 5000 });
          record.applied = result.exitCode !== 0;
          record.cleanupOutcome = "success";
          record.notes = "Dependency-unavailable condition exercised";
          break;
        }
        case "network-block": {
          record.notes = "Network-block fault is unsupported on the current backend";
          record.applied = false;
          record.cleanupOutcome = "not-needed";
          break;
        }
      }
    } catch (err) {
      record.applied = false;
      record.cleanupOutcome = "failed";
      record.notes = `Fault application failed: ${String(err)}`;
    }

    record.endedAt = new Date().toISOString();
    const updated = await this.readFaults(experimentId);
    const index = updated.findIndex((f) => f.id === record.id);
    if (index >= 0) updated[index] = record; else updated.push(record);
    await writeFile(await this.faultsPath(experimentId), JSON.stringify(updated, null, 2));
    return record;
  }

  private isSupported(type: FaultType): boolean {
    const capability = this.capabilities().find((c) => c.type === type);
    return capability?.support !== "unsupported";
  }

  private async persist(experimentId: string, faults: FaultRecord[]): Promise<void> {
    await writeFile(await this.faultsPath(experimentId), JSON.stringify(faults, null, 2));
  }
}