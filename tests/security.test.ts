import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { SandboxManager } from "../src/core/sandbox.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Capability check: can this process create directory links?
let canSymlink = false;
let symlinkType: "file" | "dir" | "junction" | undefined;
try {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "envia-sym-"));
  const target = path.join(d, "target");
  const link = path.join(d, "link");
  await fs.mkdir(target);
  const type = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(target, link, type as any);
  await fs.rm(d, { recursive: true, force: true });
  canSymlink = true;
  symlinkType = type as any;
} catch {
  canSymlink = false;
}

let tmp: string;
let mgr: SandboxManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-sec-"));
  mgr = new SandboxManager({ baseDir: tmp, allowHostCommands: true });
  await mgr.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Security: host execution default", () => {
  it("disables arbitrary command execution by default", async () => {
    const disabledMgr = new SandboxManager({ baseDir: await fs.mkdtemp(path.join(os.tmpdir(), "envia-disabled-")), allowHostCommands: false });
    await disabledMgr.init();
    const sb = await disabledMgr.create("disabled");
    await expect(disabledMgr.run(sb.id, { command: "echo", args: ["hi"] })).rejects.toThrow(/disabled by default/i);
    const entries = await disabledMgr.readAudit();
    expect(entries.some((e) => e.action === "sandbox.run" && e.ok === false)).toBe(true);
    await disabledMgr.destroy(sb.id);
    await fs.rm(disabledMgr.base, { recursive: true, force: true });
  });
});

describe("Security: path traversal", () => {
  it("blocks ../ in read", async () => {
    const sb = await mgr.create("p");
    await expect(mgr.readFileInSandbox(sb.id, "../outside.txt")).rejects.toThrow();
  });
  it("blocks ../ in write", async () => {
    const sb = await mgr.create("p");
    await expect(mgr.writeFileInSandbox(sb.id, "../outside.txt", "x")).rejects.toThrow();
  });
  it("blocks ../ in list", async () => {
    const sb = await mgr.create("p");
    await expect(mgr.listFiles(sb.id, "../")).rejects.toThrow();
  });
  it("blocks absolute path outside sandbox", async () => {
    const sb = await mgr.create("p");
    const outside = path.join(os.tmpdir(), "envia-outside.txt");
    await expect(mgr.readFileInSandbox(sb.id, outside)).rejects.toThrow();
    await expect(mgr.writeFileInSandbox(sb.id, outside, "x")).rejects.toThrow();
  });
  it("blocks .. segments embedded in path", async () => {
    const sb = await mgr.create("p");
    await expect(mgr.readFileInSandbox(sb.id, "a/../../outside.txt")).rejects.toThrow();
  });
  it("blocks NUL bytes", async () => {
    const sb = await mgr.create("p");
    await expect(mgr.readFileInSandbox(sb.id, "a\0b")).rejects.toThrow();
  });
});

describe("Security: symlink escape", () => {
  it.skipIf(!canSymlink)("blocks symlink read escape", async () => {
    const sb = await mgr.create("sym");
    // Create a real outside file
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "envia-out-"));
    const secret = path.join(outsideDir, "secret.txt");
    await fs.writeFile(secret, "secret");
    // Create link inside sandbox pointing outside
    const linkPath = path.join(sb.rootDir, "link");
    await fs.symlink(outsideDir, linkPath, symlinkType as any);
    await expect(mgr.readFileInSandbox(sb.id, "link/secret.txt")).rejects.toThrow();
    await fs.rm(outsideDir, { recursive: true, force: true });
  });
  it.skipIf(!canSymlink)("blocks symlink write escape", async () => {
    const sb = await mgr.create("sym");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "envia-out-"));
    const linkPath = path.join(sb.rootDir, "link");
    await fs.symlink(outsideDir, linkPath, symlinkType as any);
    await expect(mgr.writeFileInSandbox(sb.id, "link/evil.txt", "x")).rejects.toThrow();
    // Ensure file was not created outside
    await expect(fs.access(path.join(outsideDir, "evil.txt"))).rejects.toThrow();
    await fs.rm(outsideDir, { recursive: true, force: true });
  });
});

describe("Security: snapshots", () => {
  it("rejects invalid snapshot id", async () => {
    const sb = await mgr.create("snap");
    await expect(mgr.restore(sb.id, "../etc/passwd")).rejects.toThrow();
    await expect(mgr.restore(sb.id, "not-a-uuid")).rejects.toThrow();
  });
  it("rejects corrupted archive metadata", async () => {
    const sb = await mgr.create("snap");
    const snap = await mgr.snapshot(sb.id);
    // Corrupt metadata
    await fs.writeFile(path.join(tmp, "snapshots", `${snap.id}.json`), "{not json");
    await expect(mgr.restore(sb.id, snap.id)).rejects.toThrow();
  });
  it("rejects path traversal in archive", async () => {
    const sb = await mgr.create("snap");
    const evil = path.join(tmp, "evil.tar.gz");
    // Build evil archive with traversal entry
    const py = `import tarfile,io
p=${JSON.stringify(evil.replace(/\\/g, "/"))}
with tarfile.open(p,'w:gz') as t:
    ti=tarfile.TarInfo('../escape.txt'); ti.size=4; t.addfile(ti, io.BytesIO(b'evil'))
`;
    await fs.writeFile(path.join(tmp, "makevil.py"), py);
    await execFileAsync("python", [path.join(tmp, "makevil.py")]);
    // Point a fake snapshot metadata to evil archive by copying
    const fakeId = crypto.randomUUID();
    await fs.copyFile(evil, path.join(tmp, "snapshots", `${fakeId}.tar.gz`));
    await fs.writeFile(
      path.join(tmp, "snapshots", `${fakeId}.json`),
      JSON.stringify({ id: fakeId, sandboxId: sb.id, path: path.join(tmp, "snapshots", `${fakeId}.tar.gz`), createdAt: new Date().toISOString(), sizeBytes: 1 })
    );
    await expect(mgr.restore(sb.id, fakeId)).rejects.toThrow();
  });
  it("rejects symlink entries in archive", async () => {
    const sb = await mgr.create("snap");
    const evil = path.join(tmp, "symlink.tar.gz");
    const py = `import tarfile
p=${JSON.stringify(evil.replace(/\\/g, "/"))}
with tarfile.open(p,'w:gz') as t:
    ti=tarfile.TarInfo('link'); ti.type=tarfile.SYMTYPE; ti.linkname='C:/Windows'; t.addfile(ti)
`;
    await fs.writeFile(path.join(tmp, "makesym.py"), py);
    await execFileAsync("python", [path.join(tmp, "makesym.py")]);
    const fakeId = crypto.randomUUID();
    await fs.copyFile(evil, path.join(tmp, "snapshots", `${fakeId}.tar.gz`));
    await fs.writeFile(
      path.join(tmp, "snapshots", `${fakeId}.json`),
      JSON.stringify({ id: fakeId, sandboxId: sb.id, path: path.join(tmp, "snapshots", `${fakeId}.tar.gz`), createdAt: new Date().toISOString(), sizeBytes: 1 })
    );
    await expect(mgr.restore(sb.id, fakeId)).rejects.toThrow();
  });
  it("rejects oversized snapshot", async () => {
    const sb = await mgr.create("big");
    sb.policy.maxSnapshotBytes = 1;
    await mgr.writeFileInSandbox(sb.id, "x.txt", "hello");
    await expect(mgr.snapshot(sb.id)).rejects.toThrow(/exceeds maximum size/i);
  });
  it("rejects oversized restore archive", async () => {
    const source = await mgr.create("source");
    await mgr.writeFileInSandbox(source.id, "x.txt", "hello");
    const snap = await mgr.snapshot(source.id);
    const target = await mgr.create("target");
    target.policy.maxSnapshotBytes = 1;
    const fakeId = crypto.randomUUID();
    await fs.copyFile(snap.path, path.join(tmp, "snapshots", `${fakeId}.tar.gz`));
    await fs.writeFile(
      path.join(tmp, "snapshots", `${fakeId}.json`),
      JSON.stringify({ id: fakeId, sandboxId: target.id, path: path.join(tmp, "snapshots", `${fakeId}.tar.gz`), createdAt: new Date().toISOString(), sizeBytes: 1 })
    );
    await expect(mgr.restore(target.id, fakeId)).rejects.toThrow(/exceeds maximum size/i);
  });
});

describe("Security: command execution", () => {
  it("times out long-running commands", async () => {
    const sb = await mgr.create("timeout", { allowHostCommands: true });
    const res = await mgr.run(sb.id, {
      command: process.platform === "win32" ? "ping" : "sleep",
      args: process.platform === "win32" ? ["-n", "10", "127.0.0.1"] : ["10"],
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
  }, 10000);
  it("truncates large output and terminates", async () => {
    const sb = await mgr.create("big", { allowHostCommands: true, maxOutputBytes: 1024 });
    const res = await mgr.run(sb.id, {
      command: process.platform === "win32" ? "cmd" : "yes",
      args: process.platform === "win32" ? ["/c", "for /L %i in (1,1,100000) do @echo AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] : [],
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(2048);
  }, 15000);
  it("records failed command in audit log", async () => {
    const sb = await mgr.create("fail", { allowHostCommands: true });
    const res = await mgr.run(sb.id, {
      command: process.platform === "win32" ? "cmd" : "false",
      args: process.platform === "win32" ? ["/c", "exit 1"] : [],
    });
    expect(res.exitCode).not.toBe(0);
    const entries = await mgr.readAudit();
    expect(entries.some((e) => e.action === "sandbox.run.finish" && e.ok === false)).toBe(true);
  });
  it("rejects dangerous environment variables", async () => {
    const sb = await mgr.create("env", { allowHostCommands: true });
    await expect(mgr.run(sb.id, {
      command: process.platform === "win32" ? "cmd" : "echo",
      args: process.platform === "win32" ? ["/c", "echo hi"] : ["hi"],
      env: { LD_PRELOAD: "evil.so" },
    })).rejects.toThrow(/dangerous env key/i);
  });
});

describe("Security: audit", () => {
  it("records failed file reads", async () => {
    const sb = await mgr.create("auditread");
    await expect(mgr.readFileInSandbox(sb.id, "missing.txt")).rejects.toThrow();
    const entries = await mgr.readAudit();
    expect(entries.some((e) => e.action === "sandbox.readFile" && e.ok === false)).toBe(true);
  });
});

describe("Security: cleanup", () => {
  it("destroy removes sandbox and files", async () => {
    const sb = await mgr.create("del");
    await mgr.writeFileInSandbox(sb.id, "x.txt", "hi");
    await mgr.destroy(sb.id);
    expect(() => mgr.get(sb.id)).toThrow();
    await expect(fs.access(sb.rootDir)).rejects.toThrow();
  });
  it("audit log skips malformed lines", async () => {
    const sb = await mgr.create("audit");
    const auditPath = path.join(tmp, "audit.log");
    await fs.appendFile(auditPath, "{bad json}\n");
    const entries = await mgr.readAudit();
    expect(Array.isArray(entries)).toBe(true);
  });
});