import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

describe("MCP server", () => {
  it("lists tools and creates a sandbox", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("dist/mcp/server.js")],
      env: { ...process.env, ENVIA_HOME: path.join(process.env.TEMP ?? "C:/tmp", "envia-mcp-test") },
    });
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("envia_sandbox_create");
    expect(names.length).toBeGreaterThan(10);

    const created = await client.callTool({
      name: "envia_sandbox_create",
      arguments: { name: "mcp-test", network: false },
    });
    const parsed = JSON.parse((created.content as any)[0].text);
    expect(parsed.sandbox.id).toBeTruthy();

    const id = parsed.sandbox.id;
    const run = await client.callTool({
      name: "envia_sandbox_run",
      arguments: { id, command: process.platform === "win32" ? "cmd" : "echo", args: process.platform === "win32" ? ["/c", "echo hello"] : ["hello"] },
    });
    const runParsed = JSON.parse((run.content as any)[0].text);
    expect(runParsed.result.stdout.trim()).toBe("hello");

    await client.callTool({ name: "envia_sandbox_destroy", arguments: { id } });
    await client.close();
  }, 30000);
});