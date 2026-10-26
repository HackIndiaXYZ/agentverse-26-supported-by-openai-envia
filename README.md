# Envia

**Envia** is an open-source, jail-themed container platform and MCP server. It builds images from Jailfiles, runs bounded jails, manages volumes and networks, and executes AI-agent experiments with checkpoints, comparison, candidate patches, approval gates, and transactional application.

Official repository: https://github.com/HackIndiaXYZ/agentverse-26-supported-by-openai-envia

## What Envia does

Envia gives an agent a disposable copy of a project plus bounded file, snapshot, timeout, output, and audit controls. It is designed to reduce accidental host contamination and make agent runs reproducible, inspectable, and reversible.

Important honesty note: an Envia sandbox is an **isolated working directory with path and size controls**, not an operating-system security boundary. Arbitrary host command execution is **disabled by default**. When enabled through an explicit trusted-host mode, commands run on the host and are not isolated.

## Why an AI coding agent would use it

- Run experiments in separate copies of a source project instead of editing the source directly.
- Checkpoint and restore filesystem state during an investigation.
- Compare experiment outcomes and evidence.
- Produce a reviewable candidate patch before changing the source project.
- Require explicit approval and confirmation before applying a candidate.
- Apply approved changes transactionally with rollback and recovery support.
- Keep append-only audit ledgers and redact common secrets from tool output.
- Manage retention, disk usage, and bounded fault injection for testing.

## Architecture

```text
src/
  core/        Sandbox engine, types, path and size controls
  runtime/     Jail lifecycle, state store, journal, backends, jailor
  images/      Jailfile parsing, image store, tags, layers, build cache
  volumes/     Named volumes and best-effort mounts
  network/     Network metadata and Linux bridge/veth support
  jailhouse/   Multi-service orchestration
  agent/       Agent runs and ledgers
  experiments/ Checkpoints, branches, replay, comparison, change sets
  campaigns/   Multi-experiment campaigns and candidate workflow
  transactions/ Journaled candidate application and recovery
  coordination/ Cross-process locks
  security/    Redaction and source-project path protection
  mcp/         MCP server and tool registration
  cli/         Command-line interface
```

## Requirements

- Node.js >= 20
- npm
- `tar` (available by default on Windows 10+, macOS, and most Linux distributions)
- Python 3 (only for a few adversarial test fixtures)
- Claude Code CLI (optional, for plugin validation)

## Install from source

```bash
git clone https://github.com/HackIndiaXYZ/agentverse-26-supported-by-openai-envia.git
cd agentverse-26-supported-by-openai-envia
npm ci
npm run build
npm test
```

## Run the MCP server

```bash
npm start
```

The server speaks MCP over stdio. Configure clients to launch:

```text
node /absolute/path/to/dist/mcp/server.js
```

Environment:

- `ENVIA_HOME` - storage root (default `~/.envia`)
- `ENVIA_ALLOW_HOST_COMMANDS=1` - explicitly enable trusted-host command execution (default disabled)

## MCP client configuration

```json
{
  "mcpServers": {
    "envia": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp/server.js"],
      "env": { "ENVIA_HOME": "/absolute/path/to/.envia" }
    }
  }
}
```

## Claude Code plugin setup

1. Build first: `npm run build`.
2. Validate: `claude plugin validate .`
3. Install from a local path according to your Claude Code version.

The plugin registers the `envia` MCP server and `/envia`, `/envia-create`, `/envia-run`.

## CLI

```bash
node dist/cli/main.js system doctor
node dist/cli/main.js runtime capabilities
```

Installed packages also expose `envia` and `envia-mcp` binaries.

## MCP tools

Envia registers 60 MCP tools across these groups:

| Group | Examples |
|---|---|
| Sandbox | `envia_sandbox_create`, `envia_sandbox_run`, `envia_sandbox_snapshot` |
| Jails | `envia_jail_create`, `envia_jail_start`, `envia_jail_exec` |
| Images | `envia_image_list` |
| Volumes and networks | `envia_volume_list`, `envia_network_list` |
| Agent runs | `envia_agent_run` |
| Experiments | `envia_experiment_create`, `envia_experiment_checkpoint`, `envia_experiment_compare` |
| Campaigns | `envia_campaign_create`, `envia_campaign_start`, `envia_campaign_apply` |
| Transactions | `envia_transaction_list`, `envia_transaction_recover` |
| Redaction, retention, faults | `envia_redaction_policy`, `envia_retention_preview`, `envia_fault_types` |

## Security model

### Enforced by the implementation

- Sandboxes are stored under a canonicalized base directory.
- File read/write/list paths are resolved and checked against the sandbox root and explicitly allowed paths.
- Symlink and junction escapes are rejected where the host supports the required checks.
- Host command execution is disabled unless `ENVIA_ALLOW_HOST_COMMANDS=1` is set and a sandbox opts in.
- Resource limits bound runtime, output, and file size.
- Snapshots and restores use a managed tar format with path checks.
- Audit logs record sandbox operations.
- Campaigns and experiments use checkpoints, locks, journals, and approval gates.
- Candidate application requires explicit approval and a separate confirmation.
- Secret redaction is applied to tool output and exported patches.

### Not enforced / limitations

- No OS-level isolation, container, or VM boundary on the Windows host-process backend.
- Network access is metadata-only unless a real isolated backend is used.
- Multi-file application is recoverable but not globally atomic.
- Lock ownership has PID-reuse limitations.
- Provider timeout and cancellation guarantees are limited.
- Secret redaction is pattern-based and cannot detect every secret.
- Filesystem durability depends on host filesystem behavior.

## Safe usage example

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
npm run lint         # TypeScript type check
npm run build        # compile to dist/
npm test             # run Vitest suite
```

## Tests

The suite covers core sandbox behavior, MCP integration, security, runtime, images, volumes, jailhouse orchestration, agent runs, experiments, campaigns, locks, transactions, redaction, retention, and faults.

Run:

```bash
npm test
```

## Known platform restrictions

- On Windows, creating symlinks may require privileges; tests use directory junctions when needed.
- Process-tree termination uses `taskkill` on Windows and process-group signaling on POSIX.
- Network blocking is advisory.
- The Linux namespace backend is implemented but was not verified on this Windows host.

## Reproducible security evaluation

See `docs/security-evaluation.md` for threats, expected outcomes, actual outcomes, and pass/fail status.

## Release status

This repository is being prepared as the Envia v0.1.0 release candidate. No release tag or package has been published from this working tree.

## License

MIT (see LICENSE).
