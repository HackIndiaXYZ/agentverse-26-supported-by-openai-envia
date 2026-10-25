import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Jailor } from "../src/runtime/jailor.js";
import { HostProcessBackend } from "../src/runtime/backends/host-process.js";
import { ImageStore } from "../src/images/store.js";
import { ImageBuilder } from "../src/images/builder.js";
import { AgentRunManager } from "../src/agent/run-manager.js";

let tmp: string;
let jailor: Jailor;
let imageStore: ImageStore;
let manager: AgentRunManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-agent-"));
  jailor = new Jailor(tmp, new HostProcessBackend({ baseDir: tmp, allowUnsafeHostProcess: true }));
  await jailor.init();
  imageStore = new ImageStore(tmp);
  await imageStore.init();
  manager = new AgentRunManager(tmp, jailor, imageStore, true);
  await manager.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Agent runs", () => {
  it("runs a command and records a ledger", async () => {
    const ctx = path.join(tmp, "ctx");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\n");
    const builder = new ImageBuilder(imageStore, { allowUnsafeHostProcess: true });
    await builder.build({ contextDir: ctx, tag: "agent:test" });

    const record = await manager.run({
      task: "smoke",
      image: "agent:test",
      command: process.execPath,
      args: ["-e", "console.log('agent ok')"],
      env: {},
      checkpoint: true,
    });
    expect(record.status).toBe("succeeded");
    expect(record.stdout).toContain("agent ok");
    expect(record.approved).toBe(false);
    const ledger = await fs.readFile(record.ledgerPath, "utf8");
    expect(ledger).toContain("run.finished");
  });

  it("approves a run", async () => {
    const ctx = path.join(tmp, "ctx2");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\n");
    const builder = new ImageBuilder(imageStore, { allowUnsafeHostProcess: true });
    await builder.build({ contextDir: ctx, tag: "agent:test2" });
    const record = await manager.run({
      task: "approve",
      image: "agent:test2",
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      env: {},
    });
    const approved = await manager.approve(record.id);
    expect(approved.approved).toBe(true);
  });
});