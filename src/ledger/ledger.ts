import { readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

export interface LedgerEntry {
  ts: string;
  type: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export class ExecutionLedger {
  constructor(private readonly path: string) {}

  async append(type: string, detail: Record<string, unknown>): Promise<LedgerEntry> {
    let prevHash = "";
    try {
      const raw = await readFile(this.path, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]) as LedgerEntry;
        prevHash = last.hash ?? "";
      }
    } catch {
      // Ledger may not exist yet.
    }
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      type,
      detail,
      prevHash,
      hash: crypto.createHash("sha256").update(`${prevHash}:${type}:${JSON.stringify(detail)}`).digest("hex"),
    };
    await writeFile(this.path, JSON.stringify(entry) + "\n", { flag: "a" });
    return entry;
  }

  async read(limit = 1000): Promise<LedgerEntry[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries = lines.map((line) => JSON.parse(line) as LedgerEntry);
      return entries.slice(-limit);
    } catch {
      return [];
    }
  }
}