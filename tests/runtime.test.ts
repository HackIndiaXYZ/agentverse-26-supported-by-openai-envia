import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Jailor } from "../src/runtime/jailor.js";
import { HostProcessBackend } from "../src/runtime/backends/host-process.js";

let tmp: string;
let jailor: Jailor;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-rt-"));
  jailor = new Jailor(tmp, new HostProcessBackend({ baseDir: tmp, allowUnsafeHostProcess: true }));
  await jailor.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Runtime foundation", () => {
  it("reports host-process isolation as unsupported", () => {
    expect(jailor.capabilities().isolation).toBe("unsupported");
  });

  it("rejects required isolation on host-process backend", async () => {
    await expect(jailor.createJail({
      name: "isolated",
      command: process.execPath,
      args: ["-e", "console.log('hi')"],
      isolationRequired: true,
    })).rejects.toThrow(/cannot satisfy required isolation/i);
  });

  it("creates, starts, inspects, logs, stops, and removes a jail", async () => {
    const jail = await jailor.createJail({
      name: "demo",
      command: process.execPath,
      args: ["-e", "console.log('hello from jail')"],
      isolationRequired: false,
    });
    expect(jail.state).toBe("created");
    const started = await jailor.startJail(jail.id);
    expect(started.state).toBe("running");
    // Give process time to exit.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const inspected = await jailor.inspectJail(jail.id);
    expect(["running", "stopped"]).toContain(inspected.state);
    const logs = await jailor.logs(jail.id);
    expect(logs.join("\n")).toContain("hello from jail");
    const stopped = await jailor.stopJail(jail.id);
    expect(stopped.state).toBe("stopped");
    await jailor.removeJail(jail.id);
    await expect(jailor.inspectJail(jail.id)).rejects.toThrow();
  });

  it("persists jails and journal entries", async () => {
    const jail = await jailor.createJail({
      name: "persist",
      command: process.execPath,
      args: ["-e", "console.log('persist')"],
      isolationRequired: false,
    });
    const listed = await jailor.listJails();
    expect(listed.some((j) => j.id === jail.id)).toBe(true);
    const journal = await jailor.readJournal();
    expect(journal.some((e) => e.operation === "jail.create")).toBe(true);
  });

  it("executes commands in a running jail and restarts it", async () => {
    const jail = await jailor.createJail({
      name: "exec",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      isolationRequired: false,
    });
    await jailor.startJail(jail.id);
    const result = await jailor.execJail(jail.id, process.execPath, ["-e", "console.log('exec ok')"]);
    expect(result.stdout).toContain("exec ok");
    expect(result.exitCode).toBe(0);
    const restarted = await jailor.restartJail(jail.id);
    expect(restarted.state).toBe("running");
    await jailor.stopJail(jail.id);
    await jailor.removeJail(jail.id);
  });
});