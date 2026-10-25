import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class NetworkManager {
  private baseDir: string;
  private networksDir: string;
  private metadataPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.networksDir = path.join(baseDir, "networks");
    this.metadataPath = path.join(this.networksDir, "networks.json");
  }

  async init(): Promise<void> {
    await mkdir(this.networksDir, { recursive: true });
    if (!existsSync(this.metadataPath)) await writeFile(this.metadataPath, "[]");
  }

  async create(name: string, driver = "bridge"): Promise<{ name: string; driver: string; createdAt: string }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error(`invalid network name: ${name}`);
    const meta = await this.readMetadata();
    if (meta.some((n) => n.name === name)) throw new Error(`network already exists: ${name}`);
    const createdAt = new Date().toISOString();
    meta.push({ name, driver, createdAt });
    await this.writeMetadata(meta);
    return { name, driver, createdAt };
  }

  async list(): Promise<Array<{ name: string; driver: string; createdAt: string }>> {
    return this.readMetadata();
  }

  async inspect(name: string): Promise<{ name: string; driver: string; createdAt: string }> {
    const meta = await this.readMetadata();
    const network = meta.find((n) => n.name === name);
    if (!network) throw new Error(`network not found: ${name}`);
    return network;
  }

  async remove(name: string): Promise<void> {
    const meta = await this.readMetadata();
    const next = meta.filter((n) => n.name !== name);
    if (next.length === meta.length) throw new Error(`network not found: ${name}`);
    await this.writeMetadata(next);
  }

  private async readMetadata(): Promise<Array<{ name: string; driver: string; createdAt: string }>> {
    try {
      const raw = await readFile(this.metadataPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeMetadata(meta: Array<{ name: string; driver: string; createdAt: string }>): Promise<void> {
    const tmp = `${this.metadataPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, this.metadataPath);
  }
}