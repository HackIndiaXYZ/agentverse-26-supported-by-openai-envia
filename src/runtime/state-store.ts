import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { JailRecord, OperationJournalEntry } from "./types.js";

export class StateStore {
  private baseDir: string;
  private statePath: string;
  private journalPath: string;
  private lockPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.statePath = path.join(baseDir, "runtime", "jails.json");
    this.journalPath = path.join(baseDir, "runtime", "operations.jsonl");
    this.lockPath = path.join(baseDir, "runtime", ".lock");
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.baseDir, "runtime"), { recursive: true });
  }

  async readJails(): Promise<JailRecord[]> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as JailRecord[]) : [];
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async writeJails(records: JailRecord[]): Promise<void> {
    await this.withLock(async () => {
      const tmp = `${this.statePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(records, null, 2));
      await rename(tmp, this.statePath);
    });
  }

  async appendJournal(entry: OperationJournalEntry): Promise<void> {
    await this.withLock(async () => {
      await writeFile(this.journalPath, JSON.stringify(entry) + "\n", { flag: "a" });
    });
  }

  async readJournal(limit = 1000): Promise<OperationJournalEntry[]> {
    try {
      const raw = await readFile(this.journalPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries = lines.map((line) => JSON.parse(line) as OperationJournalEntry);
      return entries.slice(-limit);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    while (true) {
      try {
        const handle = await import("node:fs/promises").then((m) => m.open(this.lockPath, "wx"));
        try {
          return await fn();
        } finally {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
        }
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        if (Date.now() - started > 5000) throw new Error("state store lock timeout");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}