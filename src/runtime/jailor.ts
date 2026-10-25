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
  }

  capabilities() {
    return this.backend.capabilities();
  }

  async createJail(spec: JailSpec): Promise<JailRecord> {
    if (spec.isolationRequired !== false && this.backend.capabilities().isolation !== "enforced") {
      throw new Error("backend cannot satisfy required isolation");
    }
    const jail = await this.backend.createJail(spec);
    const jails = await this.stateStore.readJails();
    jails.push(jail);
    await this.stateStore.writeJails(jails);
    await this.journal("jail.create", jail.id, { name: spec.name, backend: jail.backend }, "success");
    return jail;
  }

  async listJails(): Promise<JailRecord[]> {
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