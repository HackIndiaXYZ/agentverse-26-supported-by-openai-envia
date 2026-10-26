import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

describe("MCP server", () => {
  it("lists tools and creates a sandbox", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("dist/mcp/server.js")],
      env: { ...process.env, ENVIA_HOME: path.join(process.env.TEMP ?? "C:/tmp", "envia-mcp-test"), ENVIA_ALLOW_HOST_COMMANDS: "1" },
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

  it("runs a campaign and applies a candidate through MCP", async () => {
    const tmp = path.join(process.env.TEMP ?? "C:/tmp", `envia-mcp-camp-${Date.now()}`);
    const projectDir = path.join(tmp, "project");
    await (await import("node:fs/promises")).mkdir(projectDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(path.join(projectDir, "app.txt"), "hello");

    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("dist/mcp/server.js")],
      env: { ...process.env, ENVIA_HOME: path.join(tmp, "envia-home"), ENVIA_ALLOW_HOST_COMMANDS: "1" },
    });
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(transport);

    const created = await client.callTool({ name: "envia_campaign_create", arguments: {
      name: "mcp-camp",
      sourceProject: projectDir,
      objective: "test",
      experiments: [{ name: "a", command: process.execPath, args: ["-e", "const fs=require('fs'); fs.writeFileSync('app.txt','changed')"] }],
    } });
    const campaign = JSON.parse((created.content as any)[0].text).campaign;

    const started = await client.callTool({ name: "envia_campaign_start", arguments: {
      id: campaign.id,
      serial: true,
      experiments: [{ name: "a", command: process.execPath, args: ["-e", "const fs=require('fs'); fs.writeFileSync('app.txt','changed')"] }],
    } });
    const startedCampaign = JSON.parse((started.content as any)[0].text).campaign;
    const expId = startedCampaign.experiments[0].experimentId;

    await client.callTool({ name: "envia_campaign_select_candidate", arguments: { id: campaign.id, experimentId: expId } });
    await client.callTool({ name: "envia_campaign_verify_candidate", arguments: { id: campaign.id } });
    await client.callTool({ name: "envia_campaign_approve", arguments: { id: campaign.id, approved: true, reason: "ok" } });
    const applied = await client.callTool({ name: "envia_campaign_apply", arguments: { id: campaign.id, confirm: true } });
    const appliedCampaign = JSON.parse((applied.content as any)[0].text).campaign;
    expect(appliedCampaign.candidate.promoted).toBe(true);

    const source = await (await import("node:fs/promises")).readFile(path.join(projectDir, "app.txt"), "utf8");
    expect(source).toBe("changed");

    const txs = await client.callTool({ name: "envia_transaction_list", arguments: {} });
    const transactions = JSON.parse((txs.content as any)[0].text).transactions;
    expect(transactions.some((tx: any) => tx.state === "committed")).toBe(true);

    await client.close();
    await (await import("node:fs/promises")).rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }, 60000);

  it("exposes and validates v0.2.0 agent intelligence tools", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("dist/mcp/server.js")],
      env: { ...process.env, ENVIA_HOME: path.join(process.env.TEMP ?? "C:/tmp", `envia-mcp-intel-${Date.now()}`) },
    });
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("envia_campaign_evaluate");
    expect(names).toContain("envia_campaign_explain_failure");
    expect(names).toContain("envia_campaign_recommend_next");
    expect(names).toContain("envia_campaign_plan");
    expect(names).toContain("envia_campaign_approve_plan");
    expect(names.length).toBe(65);

    const invalidPlan = await client.callTool({
      name: "envia_campaign_plan",
      arguments: { objective: "test", experiments: [] },
    });
    expect((invalidPlan as any).isError).toBe(true);

    await client.close();
  }, 30000);
});