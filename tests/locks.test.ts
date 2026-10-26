import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { LockManager } from "../src/coordination/lock-manager.js";

let tmp: string;
let helperPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-lock-"));
  helperPath = path.join(tmp, "lock-helper.mjs");
  await fs.writeFile(helperPath, `
import { pathToFileURL } from "node:url";
import path from "node:path";
const distPath = path.resolve("dist/coordination/lock-manager.js");
const { LockManager } = await import(pathToFileURL(distPath).href);
const baseDir = process.argv[2];
const resource = process.argv[3];
const holdMs = Number(process.argv[4] || "0");
const crash = process.argv[5] === "crash";
const timeoutMs = Number(process.argv[6] || "5000");
const lm = new LockManager(baseDir);
await lm.init();
const lock = await lm.acquire(resource, timeoutMs);
process.stdout.write("ACQUIRED\\n");
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
if (crash) process.exit(0);
process.stdin.resume();
process.stdin.on("data", async (data) => {
  if (data.toString().includes("RELEASE")) {
    await lock.release();
    process.stdout.write("RELEASED\\n");
    process.exit(0);
  }
});
`);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

function runHelper(args: string[]): ReturnType<typeof spawn> {
  return spawn(process.execPath, [helperPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

async function waitForOutput(child: ReturnType<typeof spawn>, marker: string, timeoutMs = 5000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (!output.includes(marker)) {
        clearTimeout(timer);
        reject(new Error(`helper exited ${code} before ${marker}: ${output}`));
      }
    });
  });
}

describe("Cross-process locks", () => {
  it("prevents simultaneous ownership", async () => {
    const baseDir = path.join(tmp, "envia");
    await fs.mkdir(baseDir, { recursive: true });
    const lm = new LockManager(baseDir);
    await lm.init();

    const owner = runHelper([baseDir, "resource", "0"]);
    await waitForOutput(owner, "ACQUIRED");

    const contender = runHelper([baseDir, "resource", "0", "", "200"]);
    let stderr = "";
    contender.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number>((resolve) => contender.on("exit", (code) => resolve(code ?? 0)));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("busy");

    owner.stdin.write("RELEASE\n");
    await new Promise<void>((resolve) => owner.on("exit", () => resolve()));

    const lock = await lm.acquire("resource", 1000);
    await lock.release();
    const lockPath = path.join(baseDir, "locks");
    expect(await fs.readdir(lockPath)).toHaveLength(0);
  });

  it("recovers after a crashed owner", async () => {
    const baseDir = path.join(tmp, "envia-crash");
    await fs.mkdir(baseDir, { recursive: true });

    const owner = runHelper([baseDir, "resource", "0", "crash", "5000"]);
    await waitForOutput(owner, "ACQUIRED");
    await new Promise<void>((resolve) => owner.on("exit", () => resolve()));

    const lm = new LockManager(baseDir);
    await lm.init();
    const lock = await lm.acquire("resource", 1000);
    await lock.release();
  });

  it("does not displace a live owner", async () => {
    const baseDir = path.join(tmp, "envia-live");
    await fs.mkdir(baseDir, { recursive: true });

    const owner = runHelper([baseDir, "resource", "500"]);
    await waitForOutput(owner, "ACQUIRED");

    const contender = runHelper([baseDir, "resource", "0", "", "100"]);
    let stderr = "";
    contender.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number>((resolve) => contender.on("exit", (code) => resolve(code ?? 0)));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("busy");

    owner.stdin.write("RELEASE\n");
    await new Promise<void>((resolve) => owner.on("exit", () => resolve()));
  });

  it("release by a different owner does not remove the lock", async () => {
    const baseDir = path.join(tmp, "envia-owner");
    await fs.mkdir(baseDir, { recursive: true });
    const lm = new LockManager(baseDir);
    await lm.init();
    const lock = await lm.acquire("resource", 1000);
    const metadataPath = (lock as any).lockPath as string;
    const raw = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.ownerToken = "not-the-owner";
    await fs.writeFile(metadataPath, JSON.stringify(parsed));
    await lock.release();
    expect(await fs.readFile(metadataPath, "utf8")).toContain("not-the-owner");
    await fs.rm(metadataPath, { force: true });
  });
});