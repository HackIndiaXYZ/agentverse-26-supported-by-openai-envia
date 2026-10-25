# Envia

**Envia** is an open-source MCP server and Claude Code plugin for creating, inspecting, and operating isolated working directories ("sandboxes") for AI-agent runs.

Official repository: https://github.com/HackIndiaXYZ/agentverse-26-supported-by-openai-envia

## What Envia does

Envia gives an agent a disposable working directory plus bounded file, snapshot, timeout, output, and audit controls. It is designed to reduce accidental host contamination and make agent runs reproducible and auditable.

Important honesty note: an Envia sandbox is an **isolated working directory with path and size controls**, not an operating-system security boundary. Arbitrary host command execution is **disabled by default**. When enabled through an explicit trusted-host mode, commands run on the host and are not isolated.

## Architecture

```
src/
  core/        # SandboxManager engine and types; shared by MCP and plugin
  mcp/         # MCP server (stdio) exposing sandbox tools
commands/      # Claude Code slash commands
.claude-plugin/# Plugin manifest
.mcp.json      # Plugin MCP wiring
tests/         # Unit, integration, and adversarial security tests
```

Core responsibilities:
- `src/core/sandbox.ts`: sandbox lifecycle, path canonicalization, snapshots, restore, run orchestration, audit log.
- `src/core/types.ts`: shared types and policy limits.
- `src/mcp/server.ts`: MCP tool registration and input validation.

## Requirements

- Node.js >= 20
- npm
- `tar` (available by default on Windows 10+, macOS, and most Linux distributions)
- Python 3 (only for a few adversarial test fixtures)

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
```

The server speaks MCP over stdio. Configure clients to launch `node /absolute/path/to/dist/mcp/server.js`.

Environment:
- `ENVIA_HOME` — storage root (default `~/.envia`)
- `ENVIA_ALLOW_HOST_COMMANDS=1` — explicitly enable trusted-host command execution (default disabled)

## MCP client configuration

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

## Claude Code plugin setup

1. Build first: `npm run build`.
2. Validate: `claude plugin validate .`
3. Install from local path according to your Claude Code version, or package it through a marketplace.

The plugin registers the `envia` MCP server and `/envia`, `/envia-create`, `/envia-run`.

## MCP tools

| Tool | Purpose |
|---|---|
| `envia_sandbox_create` | Create sandbox (`name`, optional limits/network) |
| `envia_sandbox_list` | List active sandboxes |
| `envia_sandbox_get` | Get sandbox details |
| `envia_sandbox_destroy` | Destroy sandbox and files |
| `envia_sandbox_run` | Run command in trusted-host mode only |
| `envia_sandbox_write_file` | Write UTF-8 file (size-limited) |
| `envia_sandbox_read_file` | Read UTF-8 file |
| `envia_sandbox_list_files` | List directory |
| `envia_sandbox_snapshot` | Create tar.gz snapshot |
| `envia_sandbox_snapshots` | List snapshots |
| `envia_sandbox_restore` | Restore snapshot safely |
| `envia_audit_log` | Read recent audit entries |

## Security model

### Enforced by the implementation

- Sandboxes are stored under a canonicalized base directory.
- File read/write/list paths are resolved and checked against the sandbox root and explicitly allowed paths.
- Symlink escapes are rejected during path canonicalization and file operations.
- NUL bytes and path traversal are rejected.
- File writes have a configurable maximum size.
- Command execution is disabled unless `ENVIA_ALLOW_HOST_COMMANDS=1` and the sandbox policy allows it.
- Command runs have timeouts, output caps, and process-tree termination attempts.
- Dangerous environment variables are rejected.
- Snapshots are validated for entry type, absolute paths, traversal, and symlink entries.
- Restore extracts into a staging directory, validates the tree, then replaces sandbox contents without following symlinks.
- Snapshot and restore enforce size limits.
- Audit entries are appended for operations and outcomes; malformed audit lines are skipped on read.

### Not enforced / limitations

- No OS-level isolation, container, or VM boundary.
- Network access is only influenced through environment variables unless a real backend is added.
- Trusted-host command execution is not sandboxed and can access the host.
- A command can read host paths it knows about; Envia's filesystem controls apply to Envia file APIs, not to arbitrary processes.
- Symlink race (TOCTOU) protection is best-effort; O_NOFOLLOW is not available on Windows in Node's constants.
- Plugin runtime compatibility is validated by manifest shape; full runtime behavior depends on the Claude Code version.

## Safe usage examples

Create a sandbox and write a file:

```text
envia_sandbox_create name="demo"
envia_sandbox_write_file id="<id>" path="notes.txt" content="hello"
envia_sandbox_read_file id="<id>" path="notes.txt"
```

Run commands only in trusted-host mode:

```bash
ENVIA_ALLOW_HOST_COMMANDS=1 npm start
```

Then:

```text
envia_sandbox_run id="<id>" command="node" args=["-e","console.log(process.cwd())"]
```

## Development

```bash
npm run dev          # run via tsx
npm run lint         # tsc --noEmit
npm run build        # tsc
npm test             # vitest
```

## Tests

- `tests/core.test.ts` — lifecycle, file operations, run, timeout, snapshot/restore.
- `tests/mcp.test.ts` — MCP integration and tool errors.
- `tests/security.test.ts` — traversal, symlinks, snapshots, command limits, audit, cleanup.

Run:

```bash
npm test
```

## Known platform restrictions

- On Windows, creating symlinks may require privileges; tests use directory junctions when needed.
- Process-tree termination uses `taskkill` on Windows and process-group signaling on POSIX.
- Network blocking is advisory.

## Reproducible security evaluation

See `docs/security-evaluation.md` for threats, expected outcomes, actual outcomes, and pass/fail status.

## Commit and push status

Built and tested locally; commits pushed to `main` of the official repository.

## License

MIT (see LICENSE).