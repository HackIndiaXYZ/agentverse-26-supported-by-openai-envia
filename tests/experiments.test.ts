import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Jailor } from "../src/runtime/jailor.js";
import { HostProcessBackend } from "../src/runtime/backends/host-process.js";
import { ImageStore } from "../src/images/store.js";
import { ExperimentManager } from "../src/experiments/manager.js";

let tmp: string;
let jailor: Jailor;
let imageStore: ImageStore;
let manager: ExperimentManager;
let projectDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-exp-"));
  jailor = new Jailor(tmp, new HostProcessBackend({ baseDir: tmp, allowUnsafeHostProcess: true }));
  await jailor.init();
  imageStore = new ImageStore(tmp);
  await imageStore.init();
  manager = new ExperimentManager(tmp, jailor, imageStore);
  await manager.init();

  projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "app.txt"), "hello");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Experiments", () => {
  it("creates, runs, checkpoints, restores, branches, and compares", async () => {
    const experiment = await manager.create("exp1", { sourceProject: projectDir, timeoutMs: 30000 });
    expect(experiment.status).toBe("running");

    const run = await manager.runCommand(experiment.id, process.execPath, ["-e", "const fs=require('fs'); fs.writeFileSync('app.txt','changed'); console.log('ok')"]);
    expect(run.exitCode).toBe(0);

    const checkpoint = await manager.checkpoint(experiment.id, "after change");
    expect(checkpoint.sizeBytes).toBeGreaterThan(0);

    // Modify again.
    await manager.runCommand(experiment.id, process.execPath, ["-e", "const fs=require('fs'); fs.writeFileSync('app.txt','changed-again')"]);

    const restored = await manager.restore(experiment.id, checkpoint.id);
    expect(restored.status).toBe("restored");

    const verify = await manager.runCommand(experiment.id, process.execPath, ["-e", "const fs=require('fs'); console.log(fs.readFileSync('app.txt','utf8'))"]);
    expect(verify.stdout.trim()).toBe("changed");

    const branch = await manager.branch(experiment.id, checkpoint.id, "alt");
    expect(branch.parentExperimentId).toBe(experiment.id);
    expect(branch.parentCheckpointId).toBe(checkpoint.id);

    const diff = await manager.compareCheckpoints(experiment.id, checkpoint.id, checkpoint.id);
    expect(diff.modified).toEqual([]);

    const timeline = await manager.timeline(experiment.id);
    expect(timeline.some((e: any) => e.type === "checkpoint.created")).toBe(true);

    await manager.dispose(experiment.id);
    await manager.dispose(branch.id);
  });

  it("cancels and disposes without touching source project", async () => {
    const experiment = await manager.create("exp2", { sourceProject: projectDir });
    await manager.cancel(experiment.id);
    const inspected = await manager.inspect(experiment.id);
    expect(inspected.status).toBe("cancelled");
    await manager.dispose(experiment.id);
    await expect(manager.inspect(experiment.id)).rejects.toThrow();
    const source = await fs.readFile(path.join(projectDir, "app.txt"), "utf8");
    expect(source).toBe("hello");
  });

  it("replays recorded commands", async () => {
    const experiment = await manager.create("exp3", { sourceProject: projectDir });
    await manager.runCommand(experiment.id, process.execPath, ["-e", "console.log('replay')"]);
    const replay = await manager.replay(experiment.id);
    expect((replay as any).results[0].stdoutMatch).toBe(true);
    await manager.dispose(experiment.id);
    await manager.dispose((replay as any).replay);
  });
});