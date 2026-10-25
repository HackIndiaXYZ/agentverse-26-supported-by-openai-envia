import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SandboxManager } from "../src/core/sandbox.js";

let tmp: string;
let mgr: SandboxManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-"));
  mgr = new SandboxManager({ baseDir: tmp, allowHostCommands: true });
  await mgr.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("SandboxManager", () => {
  it("creates and lists sandboxes", async () => {
    const sb = await mgr.create("test", { network: false });
    expect(sb.id).toBeTruthy();
    expect(mgr.list().length).toBe(1);
    expect(mgr.get(sb.id).name).toBe("test");
  });

  it("writes and reads files within sandbox", async () => {
    const sb = await mgr.create("fs");
    await mgr.writeFileInSandbox(sb.id, "a/b.txt", "hello");
    const content = await mgr.readFileInSandbox(sb.id, "a/b.txt");
    expect(content).toBe("hello");
    const files = await mgr.listFiles(sb.id, "a");
    expect(files).toContain("b.txt");
  });

  it("blocks path traversal", async () => {
    const sb = await mgr.create("sec");
    await expect(mgr.readFileInSandbox(sb.id, "../etc/passwd")).rejects.toThrow();
  });

  it("runs a command and captures output", async () => {
    const sb = await mgr.create("run");
    const res = await mgr.run(sb.id, { command: process.platform === "win32" ? "cmd" : "echo", args: process.platform === "win32" ? ["/c", "echo hi"] : ["hi"] });
    expect(res.stdout.trim()).toBe("hi");
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("times out long commands", async () => {
    const sb = await mgr.create("timeout");
    const res = await mgr.run(sb.id, {
      command: process.platform === "win32" ? "ping" : "sleep",
      args: process.platform === "win32" ? ["-n", "10", "127.0.0.1"] : ["10"],
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
  });

  it("snapshots and restores", async () => {
    const sb = await mgr.create("snap");
    await mgr.writeFileInSandbox(sb.id, "x.txt", "before");
    const snap = await mgr.snapshot(sb.id);
    await mgr.writeFileInSandbox(sb.id, "x.txt", "after");
    await mgr.restore(sb.id, snap.id);
    const content = await mgr.readFileInSandbox(sb.id, "x.txt");
    expect(content).toBe("before");
  });

  it("destroys sandbox", async () => {
    const sb = await mgr.create("del");
    await mgr.destroy(sb.id);
    expect(mgr.list().length).toBe(0);
    expect(() => mgr.get(sb.id)).toThrow();
  });

  it("audit log records actions", async () => {
    const sb = await mgr.create("audit");
    const entries = await mgr.readAudit();
    expect(entries.some((e) => e.action === "sandbox.create")).toBe(true);
  });
});