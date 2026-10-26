import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Jailor } from "../src/runtime/jailor.js";
import { HostProcessBackend } from "../src/runtime/backends/host-process.js";
import { ImageStore } from "../src/images/store.js";
import { ExperimentManager } from "../src/experiments/manager.js";
import { CampaignManager } from "../src/campaigns/manager.js";
import { RecoveryManager, DeterministicRepairProvider } from "../src/recovery/manager.js";

let tmp: string;
let jailor: Jailor;
let imageStore: ImageStore;
let experimentManager: ExperimentManager;
let campaignManager: CampaignManager;
let projectDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-camp-"));
  jailor = new Jailor(tmp, new HostProcessBackend({ baseDir: tmp, allowUnsafeHostProcess: true }));
  await jailor.init();
  imageStore = new ImageStore(tmp);
  await imageStore.init();
  experimentManager = new ExperimentManager(tmp, jailor, imageStore);
  await experimentManager.init();
  campaignManager = new CampaignManager(tmp, experimentManager);
  await campaignManager.init();
  projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "app.txt"), "hello");
});

afterEach(async () => {
  try {
    const experiments = await experimentManager.list();
    for (const experiment of experiments) await experimentManager.dispose(experiment.id).catch(() => undefined);
  } catch {
    // Ignore cleanup errors in tests.
  }
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe("Campaigns", () => {
  it("creates, starts, compares, selects, verifies, and exports a candidate", async () => {
    const campaign = await campaignManager.create("camp", {
      sourceProject: projectDir,
      objective: "test objective",
      experiments: [
        { name: "a", command: process.execPath, args: ["-e", "console.log('a')"], hypothesis: "a works" },
        { name: "b", command: process.execPath, args: ["-e", "console.log('b')"], hypothesis: "b works" },
      ],
    });
    expect(campaign.status).toBe("planned");

    const started = await campaignManager.start(campaign.id, [
      { name: "a", command: process.execPath, args: ["-e", "console.log('a')"] },
      { name: "b", command: process.execPath, args: ["-e", "console.log('b')"] },
    ], { serial: true });
    expect(started.status).toBe("completed");
    expect(started.experiments.length).toBe(2);

    const compared = await campaignManager.compare(campaign.id);
    expect(compared.comparison?.length).toBe(1);

    const expId = started.experiments[0].experimentId!;
    await campaignManager.selectCandidate(campaign.id, expId);
    await campaignManager.verifyCandidate(campaign.id);
    const patch = await campaignManager.exportCandidatePatch(campaign.id);
    expect(patch.patchPath).toContain("candidate.patch");

    const approved = await campaignManager.approveCandidate(campaign.id, true, "looks good");
    expect(approved.candidate?.approved).toBe(true);

    const report = await campaignManager.report(campaign.id);
    expect((report as any).experiments.length).toBe(2);
  });

  it("rejects invalid transitions", async () => {
    const campaign = await campaignManager.create("camp2", { sourceProject: projectDir, objective: "x", experiments: [{ name: "a", command: process.execPath, args: ["-e", "console.log('a')"] }] });
    await expect(campaignManager.cancel(campaign.id)).resolves.toBeTruthy();
    await expect(campaignManager.start(campaign.id, [{ name: "a", command: process.execPath, args: ["-e", "console.log('a')"] }])).rejects.toThrow(/cannot start/);
  });

  it("runs bounded recovery", async () => {
    const experiment = await experimentManager.create("recover", { sourceProject: projectDir, command: process.execPath, args: ["-e", "process.exit(1)"] });
    await experimentManager.runCommand(experiment.id, process.execPath, ["-e", "process.exit(1)"]);
    const recoveryManager = new RecoveryManager(experimentManager, new DeterministicRepairProvider());
    const result = await recoveryManager.recover(experiment.id, { maxAttempts: 2, timeoutMs: 5000, verificationCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] } });
    expect(result.attempts).toBeGreaterThan(0);
    expect(result.succeeded).toBe(true);
  });

  it("preserves the source project until an approved candidate is applied", async () => {
    const campaign = await campaignManager.create("baseline", {
      sourceProject: projectDir,
      objective: "change app.txt",
      experiments: [{ name: "a", command: process.execPath, args: ["-e", "const fs=require('fs'); fs.writeFileSync('app.txt','changed')"] }],
    });
    const started = await campaignManager.start(campaign.id, [
      { name: "a", command: process.execPath, args: ["-e", "const fs=require('fs'); fs.writeFileSync('app.txt','changed')" ] },
    ], { serial: true });
    expect(started.status).toBe("completed");
    expect(await fs.readFile(path.join(projectDir, "app.txt"), "utf8")).toBe("hello");

    const expId = started.experiments[0].experimentId!;
    await campaignManager.selectCandidate(campaign.id, expId);
    await campaignManager.verifyCandidate(campaign.id);
    const patch = await campaignManager.exportCandidatePatch(campaign.id);
    expect(patch.content).toContain("app.txt");

    await campaignManager.approveCandidate(campaign.id, true, "ok");
    await campaignManager.applyCandidate(campaign.id, true);
    expect(await fs.readFile(path.join(projectDir, "app.txt"), "utf8")).toBe("changed");

    const txs = await campaignManager.getTransactionManager().list();
    expect(txs.some((tx: any) => tx.state === "committed")).toBe(true);
  });

  it("lists campaigns after creation", async () => {
    await campaignManager.create("listed", { sourceProject: projectDir, objective: "x", experiments: [{ name: "a", command: process.execPath, args: ["-e", "console.log('a')"] }] });
    const campaigns = await campaignManager.list();
    expect(campaigns.length).toBeGreaterThan(0);
  });

  it("does not apply recovery changes outside the experiment workspace", async () => {
    const experiment = await experimentManager.create("unsafe-recovery", { sourceProject: projectDir, command: process.execPath, args: ["-e", "process.exit(1)"] });
    await experimentManager.runCommand(experiment.id, process.execPath, ["-e", "process.exit(1)"]);
    const provider = {
      async proposeRepair() {
        return {
          summary: "escape",
          hypothesis: "escape",
          changes: [{ path: "../escape.txt", content: "escaped" }],
          verificationCommand: { command: process.execPath, args: ["-e", "process.exit(1)"] },
          confidence: 0.1,
        };
      },
    };
    const recoveryManager = new RecoveryManager(experimentManager, provider as any);
    const result = await recoveryManager.recover(experiment.id, { maxAttempts: 1, timeoutMs: 5000, verificationCommand: { command: process.execPath, args: ["-e", "process.exit(1)"] } });
    expect(result.succeeded).toBe(false);
    await expect(fs.readFile(path.join(tmp, "escape.txt"), "utf8")).rejects.toThrow();
  });

  it("reports malformed provider output as a failed recovery attempt", async () => {
    const experiment = await experimentManager.create("bad-provider", { sourceProject: projectDir, command: process.execPath, args: ["-e", "process.exit(1)"] });
    await experimentManager.runCommand(experiment.id, process.execPath, ["-e", "process.exit(1)"]);
    const provider = { async proposeRepair() { return "not an object" as any; } };
    const recoveryManager = new RecoveryManager(experimentManager, provider as any);
    const result = await recoveryManager.recover(experiment.id, { maxAttempts: 1, timeoutMs: 5000, verificationCommand: { command: process.execPath, args: ["-e", "process.exit(1)"] } });
    expect(result.succeeded).toBe(false);
    expect(result.attemptHistory[0].outcome).toBe("failed");
  });
});