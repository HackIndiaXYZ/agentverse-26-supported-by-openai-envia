import { mkdir, readFile, writeFile, rm, readdir, stat, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ImageManifest } from "./types.js";

const execFileAsync = promisify(execFile);

export interface StoredImage {
  digest: string;
  manifest: ImageManifest;
  rootfsPath: string;
}

export class ImageStore {
  private baseDir: string;
  private imagesDir: string;
  private layersDir: string;
  private tagsPath: string;
  private cachePath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.imagesDir = path.join(baseDir, "images");
    this.layersDir = path.join(baseDir, "layers", "sha256");
    this.tagsPath = path.join(baseDir, "images", "tags.json");
    this.cachePath = path.join(baseDir, "images", "cache.json");
  }

  async init(): Promise<void> {
    await mkdir(this.imagesDir, { recursive: true });
    await mkdir(this.layersDir, { recursive: true });
    if (!existsSync(this.tagsPath)) await writeFile(this.tagsPath, "{}");
    if (!existsSync(this.cachePath)) await writeFile(this.cachePath, "{}");
  }

  imageDir(digest: string): string {
    return path.join(this.imagesDir, digest);
  }

  rootfsDir(digest: string): string {
    return path.join(this.imageDir(digest), "rootfs");
  }

  layerPath(digest: string): string {
    return path.join(this.layersDir, `${digest}.tar.gz`);
  }

  async list(): Promise<ImageManifest[]> {
    const entries = await readdir(this.imagesDir, { withFileTypes: true });
    const manifests: ImageManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(this.imagesDir, entry.name, "manifest.json");
      try {
        const raw = await readFile(manifestPath, "utf8");
        manifests.push(JSON.parse(raw) as ImageManifest);
      } catch {
        // ignore corrupt image metadata
      }
    }
    return manifests.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  async resolve(ref: string): Promise<StoredImage> {
    const digest = await this.resolveDigest(ref);
    const manifestPath = path.join(this.imageDir(digest), "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as ImageManifest;
    return { digest, manifest, rootfsPath: this.rootfsDir(digest) };
  }

  async resolveDigest(ref: string): Promise<string> {
    if (ref.startsWith("sha256:")) return ref.slice("sha256:".length);
    if (existsSync(this.imageDir(ref))) return ref;
    const tags = await this.readTags();
    const tagged = tags[ref];
    if (tagged) return tagged;
    // allow name:tag with implicit latest
    if (!ref.includes(":")) {
      const latest = tags[`${ref}:latest`];
      if (latest) return latest;
    }
    throw new Error(`image not found: ${ref}`);
  }

  async inspect(ref: string): Promise<Record<string, unknown>> {
    const image = await this.resolve(ref);
    const size = await this.directorySize(image.rootfsPath);
    return {
      digest: image.digest,
      manifest: image.manifest,
      rootfsPath: image.rootfsPath,
      sizeBytes: size,
    };
  }

  async tag(ref: string, tag: string): Promise<string> {
    const digest = await this.resolveDigest(ref);
    const tags = await this.readTags();
    tags[tag] = digest;
    await this.writeTags(tags);
    return digest;
  }

  async remove(ref: string): Promise<void> {
    const digest = await this.resolveDigest(ref);
    const tags = await this.readTags();
    for (const [tag, d] of Object.entries(tags)) {
      if (d === digest) delete tags[tag];
    }
    await this.writeTags(tags);
    const cache = await this.readCache();
    for (const [key, d] of Object.entries(cache)) {
      if (d === digest) delete cache[key];
    }
    await this.writeCache(cache);
    await rm(this.imageDir(digest), { recursive: true, force: true });
  }

  async exportImage(ref: string, outputPath: string): Promise<void> {
    const digest = await this.resolveDigest(ref);
    const dir = this.imageDir(digest);
    const resolvedOutput = path.resolve(outputPath);
    await execFileAsync("tar", ["-czf", resolvedOutput, "-C", dir, "."], { timeout: 300000 });
  }

  async importImage(inputPath: string): Promise<string> {
    const resolvedInput = path.resolve(inputPath);
    // Validate archive entries before extraction.
    const { stdout: namesOut } = await execFileAsync("tar", ["-tzf", resolvedInput], { timeout: 60000 });
    const { stdout: verboseOut } = await execFileAsync("tar", ["-tvzf", resolvedInput], { timeout: 60000 });
    const names = namesOut.split(/\r?\n/).filter(Boolean);
    const verbose = verboseOut.split(/\r?\n/).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const type = verbose[i]?.[0] ?? "-";
      if (type !== "-" && type !== "d") throw new Error(`image archive contains unsafe entry type: ${name}`);
      const normalized = name.replace(/\\/g, "/");
      if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error(`image archive contains absolute path: ${name}`);
      const segments = normalized.split("/").filter(Boolean);
      if (segments.includes("..")) throw new Error(`image archive contains path traversal: ${name}`);
    }

    const tmp = await import("node:fs/promises").then((m) => m.mkdtemp(path.join(this.baseDir, "import-")));
    try {
      await execFileAsync("tar", ["-xzf", resolvedInput, "-C", tmp], { timeout: 300000 });
      const manifestPath = path.join(tmp, "manifest.json");
      const raw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as ImageManifest;
      if (!manifest.digest) throw new Error("imported image is missing a digest");
      const target = this.imageDir(manifest.digest);
      if (existsSync(target)) await rm(target, { recursive: true, force: true });
      await rename(tmp, target);
      // tmp no longer exists; prevent finally cleanup issues
      return manifest.digest;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async saveImage(workingRoot: string, manifest: ImageManifest, cacheKey?: string): Promise<void> {
    const targetRoot = this.rootfsDir(manifest.digest);
    const targetDir = this.imageDir(manifest.digest);
    await mkdir(targetDir, { recursive: true });
    if (!existsSync(targetRoot)) {
      await mkdir(path.dirname(targetRoot), { recursive: true });
      await copyDir(workingRoot, targetRoot);
    }
    await writeFile(path.join(targetDir, "config.json"), JSON.stringify(manifest.config, null, 2));
    await writeFile(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    if (cacheKey) {
      const cache = await this.readCache();
      cache[cacheKey] = manifest.digest;
      await this.writeCache(cache);
    }
  }

  async putLayer(digest: string, sourcePath: string): Promise<void> {
    const target = this.layerPath(digest);
    if (!existsSync(target)) {
      await copyFile(sourcePath, target);
    }
  }

  async getCache(key: string): Promise<string | undefined> {
    const cache = await this.readCache();
    return cache[key];
  }

  async computeRootfsDigest(dir: string): Promise<string> {
    const entries: string[] = [];
    const dirs: string[] = [];
    await walk(dir, "", entries, dirs);
    const fileEntries: string[] = [];
    for (const rel of entries.sort()) {
      const full = path.join(dir, rel);
      const content = await readFile(full);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      const st = await stat(full);
      fileEntries.push(`${rel}\u0000${st.size}\u0000${hash}`);
    }
    const dirEntries = dirs.sort().map((d) => `dir:${d}`);
    const all = [...dirEntries, ...fileEntries].join("\n");
    return crypto.createHash("sha256").update(all).digest("hex");
  }

  async directorySize(dir: string): Promise<number> {
    let total = 0;
    await sizeWalk(dir, (size) => { total += size; });
    return total;
  }

  private async readTags(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.tagsPath, "utf8");
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async writeTags(tags: Record<string, string>): Promise<void> {
    const tmp = `${this.tagsPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(tags, null, 2));
    await rename(tmp, this.tagsPath);
  }

  private async readCache(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.cachePath, "utf8");
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async writeCache(cache: Record<string, string>): Promise<void> {
    const tmp = `${this.cachePath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2));
    await rename(tmp, this.cachePath);
  }
}

async function walk(root: string, prefix: string, files: string[], dirs: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      dirs.push(rel);
      await walk(path.join(root, entry.name), rel, files, dirs);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
}

async function sizeWalk(dir: string, onFile: (size: number) => void): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await sizeWalk(full, onFile);
    } else if (entry.isFile()) {
      const st = await stat(full);
      onFile(st.size);
    }
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(d), { recursive: true });
      await copyFile(s, d);
    }
  }
}