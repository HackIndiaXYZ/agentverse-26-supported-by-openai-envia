import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "../core/sandbox.js";

const baseDir = process.env.ENVIA_HOME ?? path.join(os.homedir(), ".envia");
const manager = new SandboxManager({ baseDir });
await manager.init();

const server = new McpServer(
  { name: "envia", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

function textResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg }, null, 2) }],
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive; stdio transport handles lifecycle.
}

main().catch((err) => {
  console.error("envia mcp server failed:", err);
  process.exit(1);
});
