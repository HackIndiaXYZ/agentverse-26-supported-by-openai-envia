import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeFile, readFile, rename } from "node:fs/promises";

export class VolumeManager {
  private baseDir: string;
  private volumesDir: string;
  private metadataPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.volumesDir = path.join(baseDir, "volumes");
    this.metadataPath = path.join(this.volumesDir, "volumes.json");
  }

  async init(): Promise<void> {
    await mkdir(this.volumesDir, { recursive: true });
    if (!existsSync(this.metadataPath)) await writeFile(this.metadataPath, "[]");
  }

  async create(name: string): Promise<{ name: string; path: string; createdAt: string }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error(`invalid volume name: ${name}`);
    const volumePath = path.join(this.volumesDir, name);
    if (existsSync(volumePath)) throw new Error(`volume already exists: ${name}`);
    await mkdir(volumePath, { recursive: true });
    const createdAt = new Date().toISOString();
    const meta = await this.readMetadata();
    meta.push({ name, path: volumePath, createdAt });
    await this.writeMetadata(meta);
    return { name, path: volumePath, createdAt };
  }

  async list(): Promise<Array<{ name: string; path: string; createdAt: string }>> {
    return this.readMetadata();
  }

  async inspect(name: string): Promise<{ name: string; path: string; createdAt: string; sizeBytes: number }> {
    const meta = await this.readMetadata();
    const volume = meta.find((v) => v.name === name);
    if (!volume) throw new Error(`volume not found: ${name}`);
    return { ...volume, sizeBytes: await this.directorySize(volume.path) };
  }

  async remove(name: string): Promise<void> {
    const meta = await this.readMetadata();
    const next = meta.filter((v) => v.name !== name);
    if (next.length === meta.length) throw new Error(`volume not found: ${name}`);
    await this.writeMetadata(next);
    await rm(path.join(this.volumesDir, name), { recursive: true, force: true });
  }

  path(name: string): string {
    return path.join(this.volumesDir, name);
  }

  private async readMetadata(): Promise<Array<{ name: string; path: string; createdAt: string }>> {
    try {
      const raw = await readFile(this.metadataPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeMetadata(meta: Array<{ name: string; path: string; createdAt: string }>): Promise<void> {
    const tmp = `${this.metadataPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, this.metadataPath);
  }

  private async directorySize(dir: string): Promise<number> {
    let total = 0;
    async function walk(current: string) {
      const entries = await readdirSafe(current);
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const st = await stat(full);
          total += st.size;
        }
      }
    }
    await walk(dir);
    return total;
  }
}

async function readdirSafe(dir: string): Promise<any[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}