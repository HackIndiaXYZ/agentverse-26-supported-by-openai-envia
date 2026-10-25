# Envia

**Envia** is hermetic, reproducible sandboxed environments for AI agent runs — exposed as an MCP server and a Claude Code plugin.

Built for HackIndia AgentVerse '26 (supported by OpenAI). Official repository:
https://github.com/HackIndiaXYZ/agentverse-26-supported-by-openai-envia

## What Envia does

Agents that run commands, write files, and install dependencies can corrupt the host or leave un-reproducible state. Envia gives an agent a disposable, isolated working directory with:

- A private filesystem root per sandbox
- Path traversal protection (reads/writes stay inside the sandbox + explicitly allowed paths)
- Network disabled by default (best-effort env-based blocking)
- Per-run timeouts and output capture
- Tar.gz snapshots and restore for reproducibility
- An append-only audit log of every action

The core engine is shared by both the MCP server and the plugin — there is no duplicated logic.

## Architecture

```
src/
  core/        # SandboxManager engine + types (no host dependencies)
  mcp/         # MCP server (stdio) wrapping the engine
commands/      # Claude Code slash commands
.claude-plugin/# Plugin manifest
.mcp.json      # Plugin MCP wiring
tests/         # Unit + integration tests
```

## Requirements

- Node.js >= 20
- npm
- (optional) tar (bundled on Windows 10+/macOS/Linux)

## Install

```bash
git clone https://github.com/HackIndiaXYZ/agentverse-26-supported-by-openai-envia.git
cd agentverse-26-supported-by-openai-envia
npm install
npm run build
```

## Run the MCP server

```bash
npm start
# or
node dist/mcp/server.js
```

The server speaks MCP over stdio. Configure your client to launch `node /path/to/dist/mcp/server.js`.

Environment variables:
- `ENVIA_HOME` — storage root (default `~/.envia`)

## Use as an MCP server (manual config)

Claude Desktop / Cursor / any stdio MCP client:

```json
{
  "mcpServers": {
    "envia": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp/server.js"],
      "env": { "ENVIA_HOME": "/home/you/.envia" }
    }
  }
}
```

## Use as a Claude Code plugin

1. Build first: `npm run build`.
2. In Claude Code: `/plugin install /path/to/repo` (or add the repo as a local marketplace source).
3. The plugin registers the `envia` MCP server and slash commands `/envia`, `/envia-create`, `/envia-run`.

## MCP tools

| Tool | Description |
|---|---|
| `envia_sandbox_create` | Create a sandbox (name, network?, maxRuntimeMs?, allowedPaths?) |
| `envia_sandbox_list` | List active sandboxes |
| `envia_sandbox_get` | Get sandbox details |
| `envia_sandbox_destroy` | Destroy a sandbox |
| `envia_sandbox_run` | Run a command (command, args?, cwd?, timeoutMs?, env?) |
| `envia_sandbox_write_file` | Write a text file |
| `envia_sandbox_read_file` | Read a text file |
| `envia_sandbox_list_files` | List directory |
| `envia_sandbox_snapshot` | Tar.gz snapshot |
| `envia_sandbox_snapshots` | List snapshots |
| `envia_sandbox_restore` | Restore from snapshot |
| `envia_audit_log` | Read recent audit entries |

## Development

```bash
npm run dev          # run via tsx
npm test             # vitest
npm run build        # tsc
npm run lint         # tsc --noEmit
```

## Tests

- `tests/core.test.ts` — engine: create/run/timeout/snapshot/restore/destroy/audit/path traversal.
- `tests/mcp.test.ts` — MCP integration: tool listing + create + run + destroy.

## Limitations / honesty

- Network isolation is best-effort (env vars), not OS-level firewalling. No Docker dependency by design.
- Command allowlisting is not implemented; the sandbox isolates filesystem root but a command can still read host paths it knows about. Use `allowedPaths` for explicit grants and review audit logs.
- Plugin integration is verified for Claude Code manifest shape; runtime plugin loading depends on Claude Code version.
- Not published to npm; source install only.

## License

MIT (see LICENSE).