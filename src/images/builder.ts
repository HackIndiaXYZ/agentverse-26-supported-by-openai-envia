import { mkdir, readdir, stat, copyFile, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { ImageStore } from "./store.js";
import { parseJailfile } from "./jailfile.js";
import type { ImageManifest, ImageConfig, BuildInstruction, BuildOptions, ImageLayer } from "./types.js";

const EMPTY_TAR_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class ImageBuilder {
  private store: ImageStore;
  private allowUnsafe: boolean;

  constructor(store: ImageStore, options: { allowUnsafeHostProcess?: boolean } = {}) {
    this.store = store;
    this.allowUnsafe = options.allowUnsafeHostProcess ?? false;
  }

  async build(options: BuildOptions): Promise<ImageManifest> {
    await this.store.init();
    const contextDir = path.resolve(options.contextDir);
    const jailfilePath = path.resolve(options.jailfilePath ?? defaultJailfile(contextDir));
    const text = await (await import("node:fs/promises")).readFile(jailfilePath, "utf8");
    const instructions = parseJailfile(text);

    const buildArgs: Record<string, string> = { ...(options.buildArgs ?? {}) };
    const contextHash = await this.hashContext(contextDir);

    let workingRoot = await fsMkdtemp("envia-build-");
    let parentDigest: string | null = null;
    let config: ImageConfig = defaultConfig();
    let currentLayers: ImageLayer[] = [];
    const log = (line: string) => options.onLog?.(line);

    try {
      for (const inst of instructions) {
        const rawArgs = inst.args;
        const substituted = this.substitute(rawArgs, buildArgs, config.env);
        const cacheKey = crypto.createHash("sha256").update(JSON.stringify({
          parentDigest, instruction: `${inst.type} ${substituted}`, contextHash, buildArgs,
        })).digest("hex");

        const cachedDigest = await this.store.getCache(cacheKey);
        if (cachedDigest) {
          const cached = await this.store.resolve(cachedDigest);
          await rm(workingRoot, { recursive: true, force: true });
          workingRoot = await fsMkdtemp("envia-build-");
          await copyDir(cached.rootfsPath, workingRoot);
          parentDigest = cached.digest;
          config = cloneConfig(cached.manifest.config);
          currentLayers = [...cached.manifest.layers];
          log(`[cache] ${inst.type} ${substituted}`);
          continue;
        }

        const beforeHashes = await this.snapshotHashes(workingRoot);

        switch (inst.type) {
          case "FROM": {
            const base = substituted.trim();
            const stageMatch = base.match(/^(.+?)\s+AS\s+(\S+)$/i);
            const baseRef = stageMatch ? stageMatch[1] : base;
            await rm(workingRoot, { recursive: true, force: true });
            workingRoot = await fsMkdtemp("envia-build-");
            if (baseRef.toLowerCase() !== "scratch") {
              const baseImage = await this.store.resolve(baseRef);
              await copyDir(baseImage.rootfsPath, workingRoot);
              config = cloneConfig(baseImage.manifest.config);
              parentDigest = baseImage.digest;
              currentLayers = [...baseImage.manifest.layers];
            } else {
              config = defaultConfig();
              parentDigest = null;
              currentLayers = [];
            }
            break;
          }
          case "ARG": {
            const eq = substituted.indexOf("=");
            if (eq === -1) {
              if (!(substituted in buildArgs)) buildArgs[substituted] = "";
            } else {
              const name = substituted.slice(0, eq).trim();
              const value = substituted.slice(eq + 1).trim();
              if (!(name in buildArgs)) buildArgs[name] = value;
            }
            break;
          }
          case "RUN": {
            if (!this.allowUnsafe) {
              throw new Error("RUN requires --unsafe-host-process or ENVIA_ALLOW_HOST_PROCESS_BACKEND=1");
            }
            const cwd = this.workingPath(workingRoot, config.workingDir);
            await mkdir(cwd, { recursive: true });
            const env = this.buildEnv(config.env, buildArgs);
            log(`[run] ${substituted}`);
            await this.runCommand(substituted, cwd, env, log);
            break;
          }
          case "COPY":
          case "ADD": {
            const parts = splitArgs(substituted);
            if (parts.length < 2) throw new Error(`COPY requires src and dest at line ${inst.line}`);
            const src = parts[0];
            const dest = parts.slice(1).join(" ");
            await this.copyContextPath(contextDir, src, workingRoot, dest);
            break;
          }
          case "WORKDIR": {
            const wd = substituted.trim();
            const full = this.workingPath(workingRoot, wd);
            await mkdir(full, { recursive: true });
            config.workingDir = wd.startsWith("/") ? wd : (config.workingDir === "/" ? `/${wd}` : `${config.workingDir}/${wd}`.replace(/\/+/g, "/"));
            break;
          }
          case "ENV": {
            const envEntry = parseEnv(substituted);
            // remove existing key
            config.env = config.env.filter((e) => !e.startsWith(`${envEntry.key}=`));
            config.env.push(`${envEntry.key}=${envEntry.value}`);
            break;
          }
          case "CMD": {
            config.cmd = parseCommand(substituted);
            break;
          }
          case "ENTRYPOINT": {
            config.entrypoint = parseCommand(substituted);
            break;
          }
          case "EXPOSE": {
            for (const port of substituted.split(/\s+/).filter(Boolean)) {
              config.exposedPorts[`${port}/tcp`] = {};
            }
            break;
          }
          case "LABEL": {
            const label = parseEnv(substituted);
            config.labels[label.key] = label.value;
            break;
          }
          case "USER": {
            config.user = substituted.trim();
            break;
          }
          case "VOLUME": {
            for (const volume of substituted.split(/\s+/).filter(Boolean)) {
              config.volumes[volume] = {};
            }
            break;
          }
          case "STOPSIGNAL": {
            config.stopSignal = substituted.trim();
            break;
          }
          case "SHELL": {
            config.shell = parseCommand(substituted);
            break;
          }
          case "HEALTHCHECK": {
            throw new Error(`HEALTHCHECK is not implemented yet (line ${inst.line})`);
          }
          default:
            throw new Error(`unsupported instruction ${inst.type} at line ${inst.line}`);
        }

        // Save a new image for every instruction, matching Docker layer semantics.
        const layerTarPath = await this.createLayerTar(workingRoot, beforeHashes);
        const layerDigest = sha256(await readFile(layerTarPath));
        await this.store.putLayer(layerDigest, layerTarPath);
        const rootfsDigest = await this.store.computeRootfsDigest(workingRoot);
        const configDigest = sha256(JSON.stringify(config));
        const created = new Date().toISOString();
        const imageDigest = sha256(JSON.stringify({ parentDigest, rootfsDigest, configDigest, createdBy: `${inst.type} ${substituted}`, created }));
        const manifest: ImageManifest = {
          schemaVersion: 1,
          mediaType: "application/vnd.envia.image.manifest.v1+json",
          digest: imageDigest,
          parentDigest,
          created,
          createdBy: `${inst.type} ${substituted}`,
          configDigest,
          rootfsDigest,
          config: cloneConfig(config),
          layers: [...currentLayers, { digest: layerDigest, size: await fileSize(layerTarPath), createdBy: `${inst.type} ${substituted}` }],
        };

        await this.store.saveImage(workingRoot, manifest, cacheKey);
        parentDigest = imageDigest;
        currentLayers = manifest.layers;
        log(`[build] ${inst.type} ${substituted} -> ${imageDigest.slice(0, 12)}`);
      }

      if (options.tag) {
        await this.store.tag(parentDigest!, options.tag);
      }

      const finalImage = await this.store.resolve(parentDigest!);
      return finalImage.manifest;
    } finally {
      await rm(workingRoot, { recursive: true, force: true }).catch(() => undefined);
      // clean temp layer tar files
    }
  }

  private async runCommand(command: string, cwd: string, env: Record<string, string>, log: (line: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, { shell: true, cwd, env: { ...process.env, ...env }, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`RUN timed out after 300000ms`));
      }, 300000);
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        for (const line of text.split(/\r?\n/)) if (line) log(line);
      });
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split(/\r?\n/)) if (line) log(line);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`RUN failed with exit code ${code}\n${stdout}\n${stderr}`.trim()));
      });
    });
  }

  private async hashContext(contextDir: string): Promise<string> {
    const files: string[] = [];
    await collectFiles(contextDir, contextDir, files, new Set([".git", "node_modules", ".envia", "dist"]));
    files.sort();
    const entries: string[] = [];
    for (const rel of files) {
      const full = path.join(contextDir, rel);
      const st = await stat(full);
      if (!st.isFile()) continue;
      const content = await (await import("node:fs/promises")).readFile(full);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      entries.push(`${rel}\u0000${st.size}\u0000${hash}`);
    }
    return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
  }

  private async snapshotHashes(root: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const files: string[] = [];
    await collectFiles(root, root, files, new Set());
    for (const rel of files) {
      const full = path.join(root, rel);
      const st = await stat(full);
      if (!st.isFile()) continue;
      const content = await (await import("node:fs/promises")).readFile(full);
      map.set(rel, crypto.createHash("sha256").update(content).digest("hex"));
    }
    return map;
  }

  private async createLayerTar(root: string, before: Map<string, string>): Promise<string> {
    // returns path to layer tar.gz
    const stage = await fsMkdtemp("envia-layer-");
    try {
      const afterFiles: string[] = [];
      await collectFiles(root, root, afterFiles, new Set());
      const afterMap = new Map<string, string>();
      for (const rel of afterFiles) {
        const full = path.join(root, rel);
        const st = await stat(full);
        if (!st.isFile()) continue;
        const content = await (await import("node:fs/promises")).readFile(full);
        afterMap.set(rel, crypto.createHash("sha256").update(content).digest("hex"));
      }

      // Added or modified files.
      let changed = false;
      for (const [rel, hash] of afterMap) {
        if (before.get(rel) !== hash) {
          const src = path.join(root, rel);
          const dest = path.join(stage, rel);
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(src, dest);
          changed = true;
        }
      }
      // Deleted files become whiteouts.
      for (const rel of before.keys()) {
        if (!afterMap.has(rel)) {
          const dir = path.dirname(rel);
          const base = path.basename(rel);
          const whiteoutDir = dir === "." ? stage : path.join(stage, dir);
          await mkdir(whiteoutDir, { recursive: true });
          await writeFile(path.join(whiteoutDir, `.wh.${base}`), "");
          changed = true;
        }
      }

      const tarPath = path.join(stage, "layer.tar.gz");
      // Tar the staged content (excluding the tar file itself) by staging files in a separate dir.
      const contentDir = path.join(stage, "content");
      await mkdir(contentDir, { recursive: true });
      // Move staged entries into contentDir.
      for (const entry of await readdir(stage)) {
        if (entry === "content" || entry === "layer.tar.gz") continue;
        await moveEntry(path.join(stage, entry), path.join(contentDir, entry));
      }
      if ((await readdir(contentDir)).length === 0) {
        // create an empty marker so tar has deterministic content
        await writeFile(path.join(contentDir, ".envia-empty"), "");
      }
      await execFileAsync("tar", ["-czf", tarPath, "-C", contentDir, "."], { timeout: 300000 });
      return tarPath;
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async lastLayerTarPath(root: string): Promise<string> {
    // The createLayerTar function stores the tar path in a sidecar? We need track it.
    // To avoid statefulness, recompute path is not possible. Instead, modify createLayerTar to return path.
    // This method is unused; kept for compatibility.
    throw new Error("internal error: layer tar path not tracked");
  }

  private substitute(text: string, buildArgs: Record<string, string>, env: string[]): string {
    const envMap: Record<string, string> = {};
    for (const entry of env) {
      const idx = entry.indexOf("=");
      if (idx !== -1) envMap[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    const lookup = (key: string) => (key in buildArgs ? buildArgs[key] : (envMap[key] ?? ""));
    return text
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => lookup(key))
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => lookup(key));
  }

  private buildEnv(env: string[], buildArgs: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = { ...buildArgs };
    for (const entry of env) {
      const idx = entry.indexOf("=");
      if (idx !== -1) result[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return result;
  }

  private workingPath(root: string, wd: string): string {
    const cleaned = wd.replace(/^\/+/, "");
    return path.join(root, cleaned || ".");
  }

  private async copyContextPath(contextDir: string, src: string, root: string, dest: string): Promise<void> {
    const srcPath = path.resolve(contextDir, src);
    if (!isWithin(contextDir, srcPath)) throw new Error(`COPY source escapes build context: ${src}`);
    const st = await stat(srcPath).catch(() => null);
    if (!st) throw new Error(`COPY source not found: ${src}`);
    const destPath = resolveInRoot(root, dest);

    if (st.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      const entries = await readdir(srcPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error(`COPY does not support symlinks: ${src}`);
        const s = path.join(srcPath, entry.name);
        const d = path.join(destPath, entry.name);
        if (entry.isDirectory()) await copyDir(s, d);
        else if (entry.isFile()) {
          await mkdir(path.dirname(d), { recursive: true });
          await copyFile(s, d);
        }
      }
    } else if (st.isFile()) {
      const target = dest.endsWith("/") || (await pathExists(destPath) && (await stat(destPath)).isDirectory())
        ? path.join(destPath, path.basename(srcPath))
        : destPath;
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(srcPath, target);
    } else {
      throw new Error(`COPY source is not a file or directory: ${src}`);
    }
  }
}

// Helper functions
function defaultConfig(): ImageConfig {
  return {
    architecture: process.arch === "x64" ? "amd64" : process.arch,
    os: "linux",
    env: [],
    workingDir: "/",
    exposedPorts: {},
    volumes: {},
    labels: {},
  };
}

function cloneConfig(config: ImageConfig): ImageConfig {
  return JSON.parse(JSON.stringify(config)) as ImageConfig;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fsMkdtemp(prefix: string): Promise<string> {
  return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
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

function isWithin(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function resolveInRoot(root: string, input: string): string {
  const cleaned = input.startsWith("/") ? input.slice(1) : input;
  const resolved = path.resolve(root, cleaned);
  if (!isWithin(root, resolved)) throw new Error(`path escapes image root: ${input}`);
  return resolved;
}

async function collectFiles(root: string, current: string, out: string[], ignored: Set<string>): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) await collectFiles(root, full, out, ignored);
    else out.push(rel.replace(/\\/g, "/"));
  }
}

function splitArgs(value: string): string[] {
  // Simple whitespace split; quoted segments are not specially handled.
  return value.trim().split(/\s+/).filter(Boolean);
}

function parseEnv(value: string): { key: string; value: string } {
  const eq = value.indexOf("=");
  if (eq !== -1) return { key: value.slice(0, eq).trim(), value: value.slice(eq + 1).trim() };
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`invalid ENV/LABEL: ${value}`);
  return { key: parts[0], value: parts.slice(1).join(" ") };
}

function parseCommand(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed as string[];
    } catch {
      // fall through
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p: string): Promise<number> {
  const st = await stat(p);
  return st.size;
}

async function moveEntry(src: string, dest: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(src, dest);
}

function defaultJailfile(contextDir: string): string {
  const candidates = ["Jailfile", "Jailfile.json", "Dockerfile"];
  for (const name of candidates) {
    const full = path.join(contextDir, name);
    if (existsSync(full)) return full;
  }
  return path.join(contextDir, "Jailfile");
}

// cleanup complete
