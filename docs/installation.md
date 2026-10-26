# Envia installation and MCP setup

This guide covers a clean, reproducible installation of Envia v0.1.0 from source. It is written for the Windows host-process backend, which is the verified backend for this milestone.

## 1. Prerequisites

- Node.js >= 20
- npm
- Git
- `tar` (bundled with modern Windows, macOS, and Linux)
- Python 3 (only for a few adversarial test fixtures)
- Claude Code CLI (optional, for plugin validation and plugin installation)

Verify:

```bash
node --version
npm --version
git --version
```

## 2. Install from source

```bash
git clone https://github.com/HackIndiaXYZ/agentverse-26-supported-by-openai-envia.git
cd agentverse-26-supported-by-openai-envia
npm ci
npm run build
npm test
```

`npm ci` uses the committed `package-lock.json`. `npm run build` creates the `dist/` output required by the MCP server, CLI, and plugin. `npm test` runs the Vitest suite.

## 3. Verify the installation

```bash
node dist/cli/main.js system doctor
```

Expected output is JSON containing the storage path, backend name (`host-process`), capabilities, and platform. On Windows, `isolation` and `network` are reported as `unsupported`.

You can also inspect runtime capabilities:

```bash
node dist/cli/main.js runtime capabilities
```

## 4. Configure Envia as an MCP server

Envia uses stdio. The client launches `node /absolute/path/to/dist/mcp/server.js`.

Generic configuration:

```json
{
  "mcpServers": {
    "envia": {
      "command": "node",
      "args": ["/absolute/path/to/envia/dist/mcp/server.js"],
      "env": {
        "ENVIA_HOME": "/absolute/path/to/.envia"
      }
    }
  }
}
```

Environment variables:

- `ENVIA_HOME`: storage root. Default: `~/.envia`.
- `ENVIA_ALLOW_HOST_COMMANDS=1`: explicitly enable trusted-host command execution. Default: disabled. Commands run on the host and are not isolated.

## 5. Start and verify the server

Start manually:

```bash
node /absolute/path/to/envia/dist/mcp/server.js
```

The process should remain running and speak MCP over stdio. It does not print a startup banner.

A minimal JSON-RPC initialize request should return a server info object with `name: "envia"` and `version: "0.1.0"`.

Tool discovery should return 65 tools, including `envia_campaign_evaluate`, `envia_campaign_recommend_next`, `envia_campaign_plan`, and `envia_transaction_recover`.

## 6. Troubleshooting

- `Cannot find module ... dist/mcp/server.js`: run `npm run build`.
- Node version errors: use Node.js >= 20.
- MCP client cannot start the server: use an absolute path in `args`.
- Permission errors on `ENVIA_HOME`: choose a writable directory or unset `ENVIA_HOME`.
- Commands are rejected: set `ENVIA_ALLOW_HOST_COMMANDS=1` only in a trusted environment.
- `npm ci` fails: ensure the repository and lockfile are intact; do not delete `package-lock.json`.

## 7. Storage layout

By default, Envia stores state under `~/.envia` (or `ENVIA_HOME`):

- sandboxes and audit logs
- jail records and journals
- image store and build cache
- volumes
- network metadata
- agent run ledgers
- experiment checkpoints and timelines
- campaign records
- transaction journals and backups
- cross-process lock files
- retention and fault history

Treat this directory as local, user-specific state. Do not share it between untrusted users.

## 8. Small safe test campaign

Use a temporary project:

```bash
mkdir -p /tmp/envia-test/project
printf 'hello' > /tmp/envia-test/project/app.txt
```

Then use the MCP tools in this order:

1. `envia_campaign_create`
   - `name`: `"demo"`
   - `sourceProject`: `"/tmp/envia-test/project"`
   - `objective`: `"test candidate workflow"`
   - `experiments`: two experiment definitions whose commands write different values to `app.txt`
2. `envia_campaign_start`
   - `id`: campaign id
   - `serial`: `true`
   - `experiments`: the same two definitions
3. `envia_campaign_compare`
4. `envia_campaign_select_candidate`
5. `envia_campaign_verify_candidate`
6. `envia_campaign_approve` with `approved: true`
7. `envia_campaign_apply` with `confirm: true`
8. `envia_campaign_report`

After application, verify:

- `app.txt` contains the selected candidate value.
- `envia_transaction_list` contains a committed transaction.
- unrelated files in the project remain unchanged.

## 9. No-approval path

Creating, executing, comparing, and exporting a candidate does not modify the source project. Exporting a patch requires selecting a candidate, but selection and export alone do not apply changes. Only `envia_campaign_apply` with `confirm: true` can modify the source project, and only after approval.

## 10. Inspect results and candidate diffs

Useful tools:

- `envia_campaign_status`: full campaign state.
- `envia_campaign_compare`: comparison details.
- `envia_campaign_export_patch`: reviewable patch content.
- `envia_experiment_timeline`: append-only experiment ledger.
- `envia_experiment_compare`: direct experiment comparison.
- `envia_transaction_status`: transaction state and journal.
- `envia_transaction_recover`: recover an interrupted transaction.

## 11. Recover an interrupted transaction

If application is interrupted:

1. Call `envia_transaction_list`.
2. Identify the transaction in `applying`, `recovering`, or `failed`.
3. Call `envia_transaction_recover` with the transaction id.
4. Re-run `envia_transaction_status`.
5. Verify the source project files.

Recovery is bounded and recoverable, but multi-file application is not globally atomic.

## 12. Claude Code plugin setup

1. Build first: `npm run build`.
2. Validate: `claude plugin validate .`
3. Install from a local path according to your Claude Code version.

The plugin manifest and MCP wiring were validated with `claude plugin validate .`. The plugin registers the `envia` MCP server and `/envia`, `/envia-create`, `/envia-run`.

## 13. Client-specific status

- Generic stdio MCP configuration: tested by direct JSON-RPC initialize and tool discovery against the installed package.
- Claude Code plugin: manifest validated with `claude plugin validate .`.
- Other MCP clients: use the generic configuration above; their client-specific file locations and conventions were not individually tested in this milestone and should be treated as unverified.
