import crypto from "node:crypto";
import { StateStore } from "./state-store.js";
import type { RuntimeBackend } from "./types.js";
import type { JailSpec, JailRecord, OperationJournalEntry } from "./types.js";

export class Jailor {
  private stateStore: StateStore;
  private backend: RuntimeBackend;

  constructor(baseDir: string, backend: RuntimeBackend) {
    this.stateStore = new StateStore(baseDir);
    this.backend = backend;
  }

  async init(): Promise<void> {
    await this.stateStore.init();
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    const jails = await this.stateStore.readJails();
    let changed = false;
    const next = await Promise.all(jails.map(async (jail) => {
      if (jail.state !== "running") return jail;
      try {
        const updated = await this.backend.inspectJail(jail);
        if (updated.state !== jail.state || updated.pid !== jail.pid || updated.exitCode !== jail.exitCode) changed = true;
        return updated;
      } catch {
        return jail;
      }
    }));
    if (changed) await this.stateStore.writeJails(next);
  }

  capabilities() {
    return this.backend.capabilities();
  }

  async createJail(spec: JailSpec): Promise<JailRecord> {
    if (spec.isolationRequired !== false && this.backend.capabilities().isolation !== "enforced") {
      throw new Error("backend cannot satisfy required isolation");
    }
    if (spec.networkRequired === true && this.backend.capabilities().network !== "enforced") {
      throw new Error("backend cannot satisfy required network isolation");
    }
    const jail = await this.backend.createJail(spec);
    const jails = await this.stateStore.readJails();
    jails.push(jail);
    await this.stateStore.writeJails(jails);
    await this.journal("jail.create", jail.id, { name: spec.name, backend: jail.backend }, "success");
    return jail;
  }

  async listJails(): Promise<JailRecord[]> {
    await this.reconcile();
    return this.stateStore.readJails();
  }

  async inspectJail(id: string): Promise<JailRecord> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    const updated = await this.backend.inspectJail(jail);
    const next = jails.map((j) => (j.id === id ? updated : j));
    await this.stateStore.writeJails(next);
    return updated;
  }

  async startJail(id: string): Promise<JailRecord> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    const updated = await this.backend.startJail(jail);
    const next = jails.map((j) => (j.id === id ? updated : j));
    await this.stateStore.writeJails(next);
    await this.journal("jail.start", id, { pid: updated.pid }, "success");
    return updated;
  }

  async stopJail(id: string): Promise<JailRecord> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    const updated = await this.backend.stopJail(jail);
    const next = jails.map((j) => (j.id === id ? updated : j));
    await this.stateStore.writeJails(next);
    await this.journal("jail.stop", id, {}, "success");
    return updated;
  }

  async execJail(id: string, command: string, args: string[] = [], options?: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    if (jail.state !== "running") throw new Error(`jail is not running: ${id}`);
    const result = await this.backend.execJail(jail, command, args, options);
    await this.journal("jail.exec", id, { command, args, exitCode: result.exitCode, timedOut: result.timedOut }, result.exitCode === 0 ? "success" : "failure");
    return result;
  }

  async restartJail(id: string): Promise<JailRecord> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    if (jail.state === "running") {
      const stopped = await this.backend.stopJail(jail);
      const next = jails.map((j) => (j.id === id ? stopped : j));
      await this.stateStore.writeJails(next);
      await this.journal("jail.stop", id, {}, "success");
    }
    const refreshed = (await this.stateStore.readJails()).find((j) => j.id === id)!;
    const started = await this.backend.startJail(refreshed);
    const all = await this.stateStore.readJails();
    const next = all.map((j) => (j.id === id ? started : j));
    await this.stateStore.writeJails(next);
    await this.journal("jail.start", id, { pid: started.pid }, "success");
    return started;
  }

  async removeJail(id: string): Promise<void> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    await this.backend.removeJail(jail);
    const next = jails.filter((j) => j.id !== id);
    await this.stateStore.writeJails(next);
    await this.journal("jail.remove", id, {}, "success");
  }

  async logs(id: string, lines = 100): Promise<string[]> {
    const jails = await this.stateStore.readJails();
    const jail = jails.find((j) => j.id === id);
    if (!jail) throw new Error(`jail not found: ${id}`);
    return this.backend.logs(jail, lines);
  }

  async readJournal(limit?: number): Promise<OperationJournalEntry[]> {
    return this.stateStore.readJournal(limit);
  }

  private async journal(operation: string, jailId: string | undefined, detail: Record<string, unknown>, result: "success" | "failure", error?: string): Promise<void> {
    const entry: OperationJournalEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      jailId,
      detail,
      result,
      error,
    };
    await this.stateStore.appendJournal(entry);
  }
}