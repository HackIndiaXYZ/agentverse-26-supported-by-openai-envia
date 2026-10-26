import { mkdir, rm, readFile, writeFile, readdir, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotValidationResult {
  ok: boolean;
  error?: string;
}

export async function validateArchiveEntries(archivePath: string): Promise<void> {
  const { stdout: namesOut } = await execFileAsync("tar", ["-tzf", archivePath], { timeout: 60000 });
  const { stdout: verboseOut } = await execFileAsync("tar", ["-tvzf", archivePath], { timeout: 60000 });
  const names = namesOut.split(/\r?\n/).filter(Boolean);
  const verbose = verboseOut.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const type = verbose[i]?.[0] ?? "-";
    if (type !== "-" && type !== "d") throw new Error(`snapshot contains unsafe entry type: ${name}`);
    const normalized = name.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error(`snapshot contains absolute path: ${name}`);
    const segments = normalized.split("/").filter(Boolean);
    if (segments.includes("..")) throw new Error(`snapshot contains path traversal: ${name}`);
  }
}

export async function createTarSnapshot(sourceDir: string, archivePath: string): Promise<void> {
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "."], { timeout: 300000 });
  await validateArchiveEntries(archivePath);
}

export async function extractTarSnapshot(archivePath: string, targetDir: string): Promise<void> {
  await validateArchiveEntries(archivePath);
  await mkdir(targetDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", targetDir], { timeout: 300000 });
}

export async function computeFileManifest(rootDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        const rel = path.relative(rootDir, full).replace(/\\/g, "/");
        result[rel] = crypto.createHash("sha256").update(content).digest("hex");
      }
    }
  }
  if (existsSync(rootDir)) await walk(rootDir);
  return result;
}

export async function clearDirectory(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    await rm(path.join(targetDir, entry.name), { recursive: true, force: true });
  }
}

export async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(src, dest);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(dest), { recursive: true });
      await (await import("node:fs/promises")).copyFile(src, dest);
    }
  }
}

export async function replaceDirectoryContents(targetDir: string, sourceDir: string): Promise<void> {
  const parent = path.dirname(targetDir);
  const backup = path.join(parent, `${path.basename(targetDir)}.backup-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  if (existsSync(targetDir)) await rename(targetDir, backup);
  try {
    await rename(sourceDir, targetDir);
  } catch (err) {
    if (existsSync(backup)) await rename(backup, targetDir).catch(() => undefined);
    throw err;
  }
  if (existsSync(backup)) await rm(backup, { recursive: true, force: true });
}