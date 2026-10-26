import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface RetentionPolicy {
  maxAgeDays: number;
  preserveStatuses: string[];
}

export interface RetentionPreview {
  expiredExperiments: string[];
  orphanedTempDirs: string[];
  totalBytes: number;
}

export class RetentionManager {
  private baseDir: string;
  private policyPath: string;
  private experimentsDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.policyPath = path.join(baseDir, "retention.json");
    this.experimentsDir = path.join(baseDir, "experiments");
  }

  async init(): Promise<void> {
    await mkdir(this.experimentsDir, { recursive: true });
    if (!existsSync(this.policyPath)) {
      await writeFile(this.policyPath, JSON.stringify({ maxAgeDays: 30, preserveStatuses: ["created", "running"] }, null, 2));
    }
  }

  async getPolicy(): Promise<RetentionPolicy> {
    try {
      const raw = await readFile(this.policyPath, "utf8");
      const parsed = JSON.parse(raw);
      return { maxAgeDays: parsed.maxAgeDays ?? 30, preserveStatuses: parsed.preserveStatuses ?? ["created", "running"] };
    } catch {
      return { maxAgeDays: 30, preserveStatuses: ["created", "running"] };
    }
  }

  async setPolicy(policy: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
    const current = await this.getPolicy();
    const next = { ...current, ...policy };
    await writeFile(this.policyPath, JSON.stringify(next, null, 2));
    return next;
  }

  private async directorySize(dir: string): Promise<number> {
    let total = 0;
    async function walk(current: string) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const st = await stat(full);
          total += st.size;
        }
      }
    }
    if (existsSync(dir)) await walk(dir);
    return total;
  }

  private isManagedPath(target: string): boolean {
    const resolved = path.resolve(target);
    return resolved === this.baseDir || resolved.startsWith(this.baseDir + path.sep);
  }

  async diskUsage(): Promise<{ bytes: number; experiments: number }> {
    let bytes = 0;
    let experiments = 0;
    if (!existsSync(this.experimentsDir)) return { bytes, experiments };
    const entries = await readdir(this.experimentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      experiments++;
      bytes += await this.directorySize(path.join(this.experimentsDir, entry.name));
    }
    return { bytes, experiments };
  }

  async preview(): Promise<RetentionPreview> {
    const policy = await this.getPolicy();
    const cutoff = Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000;
    const expired: string[] = [];
    const orphans: string[] = [];

    if (existsSync(this.experimentsDir)) {
      const entries = await readdir(this.experimentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) {
          try {
            const st = await stat(path.join(this.experimentsDir, entry.name));
            if (st.mtimeMs < cutoff) orphans.push(entry.name);
          } catch { /* ignore */ }
          continue;
        }
        const experimentPath = path.join(this.experimentsDir, entry.name);
        try {
          const raw = await readFile(path.join(experimentPath, "experiment.json"), "utf8");
          const record = JSON.parse(raw);
          const updated = new Date(record.updatedAt ?? record.createdAt).getTime();
          if (policy.preserveStatuses.includes(record.status)) continue;
          if (updated < cutoff) expired.push(entry.name);
        } catch {
          // Corrupt experiment directories are eligible for cleanup.
          expired.push(entry.name);
        }
      }
    }

    // Orphaned temp dirs at base level.
    const baseEntries = await readdir(this.baseDir, { withFileTypes: true });
    for (const entry of baseEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".restore-")) continue;
      const full = path.join(this.baseDir, entry.name);
      const st = await stat(full);
      if (st.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) orphans.push(entry.name);
    }

    const usage = await this.diskUsage();
    return { expiredExperiments: expired, orphanedTempDirs: orphans, totalBytes: usage.bytes };
  }

  async cleanup(dryRun = false): Promise<{ removedExperiments: string[]; removedTempDirs: string[] }> {
    const preview = await this.preview();
    if (dryRun) return { removedExperiments: preview.expiredExperiments, removedTempDirs: preview.orphanedTempDirs };

    const removedExperiments: string[] = [];
    const removedTempDirs: string[] = [];

    for (const name of preview.expiredExperiments) {
      const target = path.join(this.experimentsDir, name);
      if (!this.isManagedPath(target)) continue;
      await rm(target, { recursive: true, force: true });
      removedExperiments.push(name);
    }
    for (const name of preview.orphanedTempDirs) {
      const target = name.startsWith(".restore-") ? path.join(this.baseDir, name) : path.join(this.experimentsDir, name);
      if (!this.isManagedPath(target)) continue;
      await rm(target, { recursive: true, force: true });
      removedTempDirs.push(name);
    }
    return { removedExperiments, removedTempDirs };
  }
}