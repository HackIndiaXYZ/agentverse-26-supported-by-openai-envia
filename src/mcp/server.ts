import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "../core/sandbox.js";
import { createBackend } from "../runtime/backend-factory.js";
import { Jailor } from "../runtime/jailor.js";
import { ImageStore } from "../images/store.js";
import { VolumeManager } from "../volumes/manager.js";
import { NetworkManager } from "../network/manager.js";
import { AgentRunManager } from "../agent/run-manager.js";
import { ExperimentManager } from "../experiments/manager.js";
import { CampaignManager } from "../campaigns/manager.js";
import { RecoveryManager } from "../recovery/manager.js";
import { FaultManager } from "../faults/manager.js";
import { RetentionManager } from "../retention/manager.js";
import { JailhouseManager } from "../jailhouse/manager.js";
import { SecretRedactor } from "../security/redactor.js";

const baseDir = process.env.ENVIA_HOME ?? path.join(os.homedir(), ".envia");
const allowUnsafe = process.env.ENVIA_ALLOW_HOST_COMMANDS === "1" || process.env.ENVIA_ALLOW_HOST_PROCESS_BACKEND === "1";
const manager = new SandboxManager({ baseDir, allowHostCommands: allowUnsafe });
await manager.init();

const backend = createBackend({ baseDir, allowUnsafeHostProcess: allowUnsafe, allowUnsafeLinux: allowUnsafe });
const jailor = new Jailor(baseDir, backend);
await jailor.init();
const imageStore = new ImageStore(baseDir);
await imageStore.init();
const volumeManager = new VolumeManager(baseDir);
await volumeManager.init();
const networkManager = new NetworkManager(baseDir);
await networkManager.init();
const agentRunManager = new AgentRunManager(baseDir, jailor, imageStore, allowUnsafe);
await agentRunManager.init();
const experimentManager = new ExperimentManager(baseDir, jailor, imageStore);
await experimentManager.init();
const campaignManager = new CampaignManager(baseDir, experimentManager);
await campaignManager.init();
const faultManager = new FaultManager(baseDir, jailor);
const retentionManager = new RetentionManager(baseDir);
await retentionManager.init();
const jailhouseManager = new JailhouseManager(baseDir, jailor, imageStore, volumeManager, networkManager, allowUnsafe);
await jailhouseManager.init();

const server = new McpServer(
  { name: "envia", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

function textResult(obj: unknown) {
  const redactor = new SecretRedactor();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(redactor.redactObject(obj), null, 2) }],
  };
}

function errorResult(err: unknown) {
  const redactor = new SecretRedactor();
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: redactor.redactText(msg) }, null, 2) }],
    isError: true,
  };
}

// --- sandbox tools ---

server.registerTool(
  "envia_sandbox_create",
  {
    title: "Create sandbox",
    description: "Create a new sandbox working directory with path and size controls.",
    inputSchema: {
      name: z.string().min(1).max(128).describe("Human-readable sandbox name"),
      network: z.boolean().optional().describe("Request network access. Enforced only by a real backend; default false uses best-effort env blocking."),
      maxRuntimeMs: z.number().int().positive().max(300000).optional().describe("Per-run timeout in ms (default 30000)"),
      maxOutputBytes: z.number().int().min(1024).max(10000000).optional().describe("Max captured stdout/stderr bytes (default 1000000)"),
      maxFileBytes: z.number().int().min(1).max(50000000).optional().describe("Max bytes for a single file write (default 1000000)"),
    },
  },
  async (args) => {
    try {
      const sb = await manager.create(args.name, {
        network: args.network ?? false,
        maxRuntimeMs: args.maxRuntimeMs,
        maxOutputBytes: args.maxOutputBytes,
        maxFileBytes: args.maxFileBytes,
      });
      return textResult({ sandbox: sb });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_list",
  {
    title: "List sandboxes",
    description: "List all active sandboxes.",
    inputSchema: {},
  },
  async () => {
    try {
      return textResult({ sandboxes: manager.list() });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_get",
  {
    title: "Get sandbox",
    description: "Get details of a sandbox by id.",
    inputSchema: { id: z.string().min(1).max(64) },
  },
  async (args) => {
    try {
      return textResult({ sandbox: manager.get(args.id) });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_destroy",
  {
    title: "Destroy sandbox",
    description: "Destroy a sandbox and delete its files.",
    inputSchema: { id: z.string().min(1).max(64) },
  },
  async (args) => {
    try {
      await manager.destroy(args.id);
      return textResult({ destroyed: args.id });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_run",
  {
    title: "Run command in sandbox",
    description: "Run a command inside a sandbox and capture stdout/stderr/exit code.",
    inputSchema: {
      id: z.string().min(1).max(64).describe("Sandbox id"),
      command: z.string().min(1).max(4096).describe("Executable to run"),
      args: z.array(z.string().max(4096)).max(128).optional().describe("Arguments"),
      cwd: z.string().max(4096).optional().describe("Working dir relative to sandbox root"),
      timeoutMs: z.number().int().positive().max(300000).optional(),
      env: z.record(z.string().max(128), z.string().max(4096)).optional(),
    },
  },
  async (args) => {
    try {
      const res = await manager.run(args.id, {
        command: args.command,
        args: args.args,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        env: args.env,
      });
      return textResult({ result: res });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_write_file",
  {
    title: "Write file in sandbox",
    description: "Write a text file inside a sandbox.",
    inputSchema: {
      id: z.string().min(1).max(64),
      path: z.string().min(1).max(4096).describe("Path relative to sandbox root"),
      content: z.string().max(50000000),
    },
  },
  async (args) => {
    try {
      const target = await manager.writeFileInSandbox(args.id, args.path, args.content);
      return textResult({ written: target });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_read_file",
  {
    title: "Read file in sandbox",
    description: "Read a text file inside a sandbox.",
    inputSchema: {
      id: z.string().min(1).max(64),
      path: z.string().min(1).max(4096),
    },
  },
  async (args) => {
    try {
      const content = await manager.readFileInSandbox(args.id, args.path);
      return textResult({ path: args.path, content });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_list_files",
  {
    title: "List files in sandbox",
    description: "List directory contents inside a sandbox.",
    inputSchema: {
      id: z.string().min(1).max(64),
      path: z.string().max(4096).optional().describe("Relative dir, default '.'"),
    },
  },
  async (args) => {
    try {
      const files = await manager.listFiles(args.id, args.path ?? ".");
      return textResult({ path: args.path ?? ".", files });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_snapshot",
  {
    title: "Snapshot sandbox",
    description: "Create a tar.gz snapshot of a sandbox for later restore.",
    inputSchema: { id: z.string().min(1).max(64) },
  },
  async (args) => {
    try {
      const snap = await manager.snapshot(args.id);
      return textResult({ snapshot: snap });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_snapshots",
  {
    title: "List snapshots",
    description: "List snapshots for a sandbox.",
    inputSchema: { id: z.string().min(1).max(64) },
  },
  async (args) => {
    try {
      const snaps = await manager.listSnapshots(args.id);
      return textResult({ snapshots: snaps });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_sandbox_restore",
  {
    title: "Restore sandbox",
    description: "Restore a sandbox from a snapshot.",
    inputSchema: {
      id: z.string().min(1).max(64),
      snapshotId: z.string().min(1).max(64),
    },
  },
  async (args) => {
    try {
      await manager.restore(args.id, args.snapshotId);
      return textResult({ restored: args.id, snapshotId: args.snapshotId });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "envia_audit_log",
  {
    title: "Read audit log",
    description: "Read recent audit entries for sandbox activity.",
    inputSchema: { limit: z.number().int().positive().optional() },
  },
  async (args) => {
    try {
      const entries = await manager.readAudit(args.limit ?? 100);
      return textResult({ entries });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// --- jail tools ---

server.registerTool(
  "envia_jail_list",
  { title: "List jails", description: "List jails tracked by the Jailor.", inputSchema: {} },
  async () => {
    try { return textResult({ jails: await jailor.listJails() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_jail_create",
  {
    title: "Create jail",
    description: "Create a jail from an optional image root or command.",
    inputSchema: {
      name: z.string().min(1).max(128),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      image: z.string().optional(),
      networkMode: z.enum(["none", "host", "bridge"]).optional(),
    },
  },
  async (args) => {
    try {
      let rootfsPath: string | undefined;
      if (args.image) rootfsPath = (await imageStore.resolve(args.image)).rootfsPath;
      const jail = await jailor.createJail({
        name: args.name,
        command: args.command,
        args: args.args,
        networkMode: args.networkMode,
        isolationRequired: false,
        allowUnsafeHostProcess: allowUnsafe,
        rootfsPath,
      });
      return textResult({ jail });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_jail_start",
  { title: "Start jail", description: "Start a jail.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ jail: await jailor.startJail(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_jail_stop",
  { title: "Stop jail", description: "Stop a jail.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ jail: await jailor.stopJail(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_jail_remove",
  { title: "Remove jail", description: "Remove a jail.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { await jailor.removeJail(args.id); return textResult({ removed: args.id }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_jail_exec",
  {
    title: "Exec in jail",
    description: "Execute a command in a running jail.",
    inputSchema: { id: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).optional(), timeoutMs: z.number().int().positive().optional() },
  },
  async (args) => {
    try {
      const result = await jailor.execJail(args.id, args.command, args.args ?? [], { timeoutMs: args.timeoutMs });
      return textResult({ result });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_image_list",
  { title: "List images", description: "List stored images.", inputSchema: {} },
  async () => {
    try { return textResult({ images: await imageStore.list() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_volume_list",
  { title: "List volumes", description: "List volumes.", inputSchema: {} },
  async () => {
    try { return textResult({ volumes: await volumeManager.list() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_network_list",
  { title: "List networks", description: "List networks.", inputSchema: {} },
  async () => {
    try { return textResult({ networks: await networkManager.list() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_agent_run",
  {
    title: "Run agent task",
    description: "Create and run an Agent Run in a jail.",
    inputSchema: {
      task: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      image: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    try {
      const record = await agentRunManager.run({
        task: args.task,
        command: args.command,
        args: args.args ?? [],
        image: args.image,
        env: {},
        timeoutMs: args.timeoutMs,
      });
      return textResult({ run: record });
    } catch (e) { return errorResult(e); }
  }
);

// --- experiment tools ---

server.registerTool(
  "envia_experiment_create",
  {
    title: "Create experiment",
    description: "Create a disposable experiment from a source project.",
    inputSchema: { name: z.string().min(1), sourceProject: z.string().min(1), image: z.string().optional(), command: z.string().optional(), networkMode: z.enum(["none", "host", "bridge"]).optional() },
  },
  async (args) => {
    try {
      const record = await experimentManager.create(args.name, { sourceProject: args.sourceProject, image: args.image, command: args.command, networkMode: args.networkMode });
      return textResult({ experiment: record });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_status",
  { title: "Experiment status", description: "Inspect an experiment.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ experiment: await experimentManager.inspect(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_run",
  { title: "Run in experiment", description: "Execute a command in an experiment jail.", inputSchema: { id: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).optional(), timeoutMs: z.number().int().positive().optional() } },
  async (args) => {
    try {
      const result = await experimentManager.runCommand(args.id, args.command, args.args ?? [], { timeoutMs: args.timeoutMs });
      return textResult({ result });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_checkpoint",
  { title: "Checkpoint experiment", description: "Create a filesystem checkpoint.", inputSchema: { id: z.string().min(1), note: z.string().optional() } },
  async (args) => {
    try { return textResult({ checkpoint: await experimentManager.checkpoint(args.id, args.note) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_restore",
  { title: "Restore checkpoint", description: "Restore an experiment to a checkpoint.", inputSchema: { id: z.string().min(1), checkpointId: z.string().min(1) } },
  async (args) => {
    try { return textResult({ experiment: await experimentManager.restore(args.id, args.checkpointId) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_branch",
  { title: "Branch experiment", description: "Branch an experiment from a checkpoint.", inputSchema: { id: z.string().min(1), checkpointId: z.string().optional(), name: z.string().min(1) } },
  async (args) => {
    try { return textResult({ experiment: await experimentManager.branch(args.id, args.checkpointId, args.name) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_timeline",
  { title: "Experiment timeline", description: "Read the experiment execution ledger.", inputSchema: { id: z.string().min(1), limit: z.number().int().positive().optional() } },
  async (args) => {
    try { return textResult({ events: await experimentManager.timeline(args.id, args.limit ?? 1000) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_compare_checkpoints",
  { title: "Compare checkpoints", description: "Compare two checkpoints.", inputSchema: { id: z.string().min(1), left: z.string().min(1), right: z.string().min(1) } },
  async (args) => {
    try { return textResult({ diff: await experimentManager.compareCheckpoints(args.id, args.left, args.right) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_replay",
  { title: "Replay experiment", description: "Replay recorded commands in a new experiment branch.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ replay: await experimentManager.replay(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_cancel",
  { title: "Cancel experiment", description: "Cancel and stop an experiment.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ experiment: await experimentManager.cancel(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_dispose",
  { title: "Dispose experiment", description: "Dispose an experiment and delete its state.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { await experimentManager.dispose(args.id); return textResult({ disposed: args.id }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_prepare_change",
  { title: "Prepare change set", description: "Prepare a reviewable change set from a checkpoint.", inputSchema: { id: z.string().min(1), checkpointId: z.string().optional() } },
  async (args) => {
    try { return textResult({ changeSet: await experimentManager.prepareChangeSet(args.id, args.checkpointId) }); } catch (e) { return errorResult(e); }
  }
);

// --- redaction tools ---
server.registerTool(
  "envia_redaction_policy",
  { title: "Redaction policy", description: "Inspect the active redaction configuration.", inputSchema: {} },
  async () => {
    try {
      const config = await new (await import("../security/redactor.js")).RedactionConfigManager(baseDir).load();
      return textResult({ policy: config });
    } catch (e) { return errorResult(e); }
  }
);

// --- retention tools ---
server.registerTool(
  "envia_retention_preview",
  { title: "Retention preview", description: "Preview disposable data eligible for cleanup.", inputSchema: {} },
  async () => {
    try { return textResult({ preview: await retentionManager.preview() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_retention_cleanup",
  { title: "Retention cleanup", description: "Clean up expired disposable data. Use dryRun to preview.", inputSchema: { dryRun: z.boolean().optional() } },
  async (args) => {
    try { return textResult({ result: await retentionManager.cleanup(args.dryRun ?? false) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_retention_disk_usage",
  { title: "Retention disk usage", description: "Report Envia-managed disk usage.", inputSchema: {} },
  async () => {
    try { return textResult({ usage: await retentionManager.diskUsage() }); } catch (e) { return errorResult(e); }
  }
);

// --- fault tools ---
server.registerTool(
  "envia_fault_types",
  { title: "Fault types", description: "List supported fault types and requirements.", inputSchema: {} },
  async () => {
    try { return textResult({ faults: faultManager.capabilities() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_fault_apply",
  { title: "Apply fault", description: "Apply a bounded fault to a jail.", inputSchema: { experimentId: z.string().min(1), jailId: z.string().min(1), type: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() } },
  async (args) => {
    try {
      const record = await faultManager.applyFault(args.experimentId, args.jailId, args.type as any, (args.params ?? {}) as Record<string, unknown>);
      return textResult({ fault: record });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_fault_history",
  { title: "Fault history", description: "Read fault history for an experiment.", inputSchema: { experimentId: z.string().min(1) } },
  async (args) => {
    try { return textResult({ faults: await faultManager.readFaults(args.experimentId) }); } catch (e) { return errorResult(e); }
  }
);

// --- experiment intelligence tools ---
server.registerTool(
  "envia_experiment_update",
  {
    title: "Update experiment investigation",
    description: "Record hypothesis, objective, method, expected/observed outcomes, conclusion, confidence, evidence, and next steps.",
    inputSchema: {
      id: z.string().min(1),
      hypothesis: z.string().optional(),
      objective: z.string().optional(),
      method: z.string().optional(),
      expectedOutcome: z.string().optional(),
      observedOutcome: z.string().optional(),
      conclusion: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      evidenceRefs: z.array(z.string()).optional(),
      nextSteps: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    try {
      const { id, ...fields } = args;
      return textResult({ experiment: await experimentManager.updateInvestigation(id, fields) });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_compare",
  { title: "Compare experiments", description: "Compare two experiments and produce a structured report.", inputSchema: { leftId: z.string().min(1), rightId: z.string().min(1) } },
  async (args) => {
    try { return textResult({ comparison: await experimentManager.compareExperiments(args.leftId, args.rightId) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_experiment_export_patch",
  { title: "Export candidate patch", description: "Export a reviewable patch for a candidate change set.", inputSchema: { id: z.string().min(1), checkpointId: z.string().optional() } },
  async (args) => {
    try { return textResult({ patch: await experimentManager.exportPatch(args.id, args.checkpointId) }); } catch (e) { return errorResult(e); }
  }
);

// --- campaign tools ---
server.registerTool(
  "envia_campaign_create",
  {
    title: "Create campaign",
    description: "Create a campaign coordinating multiple experiments.",
    inputSchema: {
      name: z.string().min(1),
      sourceProject: z.string().min(1),
      objective: z.string().min(1),
      successCriteria: z.string().optional(),
      maxConcurrency: z.number().int().positive().optional(),
      experiments: z.array(z.object({
        name: z.string().min(1),
        hypothesis: z.string().optional(),
        objective: z.string().optional(),
        method: z.string().optional(),
        expectedOutcome: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
      })),
    },
  },
  async (args) => {
    try {
      const record = await campaignManager.create(args.name, {
        sourceProject: args.sourceProject,
        objective: args.objective,
        successCriteria: args.successCriteria,
        maxConcurrency: args.maxConcurrency,
        experiments: args.experiments,
      });
      return textResult({ campaign: record });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_status",
  { title: "Campaign status", description: "Inspect a campaign.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.inspect(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_list",
  { title: "List campaigns", description: "List campaigns.", inputSchema: {} },
  async () => {
    try { return textResult({ campaigns: await campaignManager.list() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_start",
  { title: "Start campaign", description: "Start or resume eligible campaign experiments.", inputSchema: { id: z.string().min(1), serial: z.boolean().optional(), experiments: z.array(z.object({ name: z.string(), command: z.string().optional(), args: z.array(z.string()).optional(), timeoutMs: z.number().int().positive().optional() })).optional() } },
  async (args) => {
    try {
      const record = await campaignManager.inspect(args.id);
      const definitions = (args.experiments ?? record.experiments.map((e) => ({ name: e.name, command: undefined, args: undefined, timeoutMs: undefined })));
      const result = await campaignManager.start(args.id, definitions as any, { serial: args.serial });
      return textResult({ campaign: result });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_cancel",
  { title: "Cancel campaign", description: "Cancel a campaign and its experiments.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.cancel(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_compare",
  { title: "Compare campaign", description: "Compare campaign experiments.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.compare(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_report",
  { title: "Campaign report", description: "Generate a campaign report.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ report: await campaignManager.report(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_evaluate",
  {
    title: "Evaluate campaign",
    description: "Evaluate campaign candidates using explicit recorded evidence and configurable criteria.",
    inputSchema: {
      id: z.string().min(1),
      config: z.any().optional(),
      evidence: z.record(z.string(), z.any()).optional(),
    },
  },
  async (args) => {
    try { return textResult({ evaluation: await campaignManager.evaluateCampaign(args.id, { config: args.config, evidence: args.evidence }) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_explain_failure",
  {
    title: "Explain campaign failure",
    description: "Produce a redacted failure-forensics report for a campaign or experiment.",
    inputSchema: { id: z.string().min(1), experimentId: z.string().min(1).optional() },
  },
  async (args) => {
    try { return textResult({ forensics: await campaignManager.explainFailure(args.id, args.experimentId) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_recommend_next",
  {
    title: "Recommend next experiment",
    description: "Recommend the next bounded action for a campaign using recorded evidence and policy.",
    inputSchema: { id: z.string().min(1) },
  },
  async (args) => {
    try { return textResult({ recommendation: await campaignManager.recommendNext(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_compare_evidence",
  {
    title: "Compare campaign evidence",
    description: "Compare candidates using recorded evidence and the configured comparison policy.",
    inputSchema: { id: z.string().min(1) },
  },
  async (args) => {
    try { return textResult({ comparison: await campaignManager.compareEvidence(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_plan",
  {
    title: "Plan campaign",
    description: "Validate and create a bounded campaign plan, optionally attaching it to a campaign.",
    inputSchema: {
      id: z.string().min(1).optional(),
      objective: z.string().min(1),
      acceptanceCriteria: z.array(z.string()).optional(),
      experiments: z.array(z.object({
        name: z.string().min(1),
        hypothesis: z.string().optional(),
        objective: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
        resourceLimits: z.object({ cpuMillis: z.number().int().nonnegative().optional(), memoryBytes: z.number().int().nonnegative().optional(), pids: z.number().int().nonnegative().optional() }).optional(),
      })),
      evaluationCriteria: z.array(z.string()).optional(),
      resourceBudget: z.object({ maxConcurrency: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }).optional(),
      attemptBudget: z.object({ maxAttempts: z.number().int().positive().optional() }).optional(),
      stopConditions: z.array(z.string()).optional(),
      approvalRequired: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const plan = campaignManager.planCampaign({
        objective: args.objective,
        acceptanceCriteria: args.acceptanceCriteria,
        experiments: args.experiments,
        evaluationCriteria: args.evaluationCriteria,
        resourceBudget: args.resourceBudget,
        attemptBudget: args.attemptBudget,
        stopConditions: args.stopConditions,
        approvalRequired: args.approvalRequired,
      });
      if (args.id) {
        const campaign = await campaignManager.attachPlan(args.id, plan);
        return textResult({ plan, campaign });
      }
      return textResult({ plan });
    } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_approve_plan",
  {
    title: "Approve campaign plan",
    description: "Approve or reject a campaign plan before execution.",
    inputSchema: { id: z.string().min(1), approved: z.boolean(), reason: z.string().optional() },
  },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.approvePlan(args.id, args.approved, args.reason) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_select_candidate",
  { title: "Select candidate", description: "Select a candidate experiment.", inputSchema: { id: z.string().min(1), experimentId: z.string().min(1) } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.selectCandidate(args.id, args.experimentId) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_verify_candidate",
  { title: "Verify candidate", description: "Verify a selected candidate.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.verifyCandidate(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_export_patch",
  { title: "Export candidate patch", description: "Export a reviewable candidate patch.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ patch: await campaignManager.exportCandidatePatch(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_approve",
  { title: "Approve candidate", description: "Approve or reject a candidate.", inputSchema: { id: z.string().min(1), approved: z.boolean(), reason: z.string().optional() } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.approveCandidate(args.id, args.approved, args.reason) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_apply",
  { title: "Apply candidate", description: "Apply an approved candidate to the source project with explicit confirmation.", inputSchema: { id: z.string().min(1), confirm: z.boolean() } },
  async (args) => {
    try { return textResult({ campaign: await campaignManager.applyCandidate(args.id, args.confirm) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_transaction_list",
  { title: "List application transactions", description: "List candidate application transactions.", inputSchema: {} },
  async () => {
    try { return textResult({ transactions: await campaignManager.getTransactionManager().list() }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_transaction_status",
  { title: "Inspect application transaction", description: "Inspect a candidate application transaction.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ transaction: await campaignManager.getTransactionManager().inspect(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_transaction_recover",
  { title: "Recover application transaction", description: "Recover an interrupted application transaction.", inputSchema: { id: z.string().min(1) } },
  async (args) => {
    try { return textResult({ transaction: await campaignManager.getTransactionManager().recover(args.id) }); } catch (e) { return errorResult(e); }
  }
);

server.registerTool(
  "envia_campaign_recover",
  { title: "Recover experiment", description: "Run a bounded recovery loop for an experiment.", inputSchema: { campaignId: z.string().min(1), experimentId: z.string().min(1), maxAttempts: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() } },
  async (args) => {
    try {
      const campaign = await campaignManager.recoverExperiment(args.campaignId, args.experimentId, { maxAttempts: args.maxAttempts, timeoutMs: args.timeoutMs });
      const lastAttempt = campaign.recoveryAttempts[campaign.recoveryAttempts.length - 1];
      return textResult({ campaign, recovery: { attempts: campaign.recoveryAttempts.length, succeeded: lastAttempt?.outcome === "succeeded", stoppedReason: lastAttempt ? "see attempt history" : "no attempts" } });
    } catch (e) { return errorResult(e); }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive; stdio transport handles lifecycle.
}

main().catch((err) => {
  console.error("envia mcp server failed:", err);
  process.exit(1);
});
