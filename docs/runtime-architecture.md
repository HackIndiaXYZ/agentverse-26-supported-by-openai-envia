# Envia Runtime: Architecture and Implementation Plan

## Product direction

Envia is an independent, open-source runtime for creating, running, inspecting, snapshotting, and destroying isolated computing environments. It is inspired by the convenience and breadth of container platforms, but it is not a Docker rebrand or a Docker wrapper.

The product vocabulary is:
- **Realm** — a created environment instance.
- **Blueprint** — a declarative definition used to construct a Realm.
- **Core** — the runtime control plane and backend manager.
- **Vault** — local storage for reusable Blueprints and snapshots; a remote registry can come later.
- **CLI** — the primary human interface.
- **Mesh** — a future multi-machine orchestration layer, explicitly out of v1 scope.

These names describe Envia concepts, not a claim that the corresponding subsystems already exist.

## Non-negotiable security rules

1. Never silently fall back from an isolated backend to host execution.
2. Treat agent-supplied commands, files, archives, and Blueprint values as untrusted.
3. Network access is denied by default and must be enforced by the selected backend, not merely by environment variables.
4. Host filesystem access is limited to explicit, minimal mounts. Never mount the container/runtime control socket into a Realm.
5. Run with an unprivileged identity; drop unnecessary capabilities and enable no-new-privileges where supported.
6. Apply bounded CPU, memory, process count, disk usage, wall-clock time, and captured output.
7. Clean up processes and resources on completion, timeout, cancellation, or crash recovery.
8. Audit security-relevant actions and their outcomes without logging secrets.
9. Report backend capabilities and limitations truthfully. A directory is not an execution security boundary.
10. Do not claim a platform is securely isolated until adversarial integration tests demonstrate the relevant boundaries.

## Architecture

Keep the existing MCP server as one client of Envia Core, not as the runtime itself.

- src/core/ — public runtime API, Realm lifecycle, policy validation, audit, artifact metadata.
- src/runtime/ — backend contract, capability detection, backend selection, process lifecycle and error types.
- src/runtime/linux/ — future Linux-native backend using established kernel primitives (namespaces, cgroups, seccomp and filesystem isolation) where correctly available.
- src/runtime/windows/ — separately engineered Windows backend; never assume Linux primitives apply.
- src/blueprints/ — Blueprint schema, validation, build plan and reproducibility metadata.
- src/vault/ — local content-addressed artifact/snapshot storage.
- src/cli/ — commands such as envia realm create/run/inspect/stop/destroy, envia blueprint build/inspect, and envia vault list.
- src/mcp/ — MCP tools mapped to the same Core APIs.
- tests/security/ — backend-specific adversarial and isolation tests.

The current filesystem sandbox manager can remain as a file-operation facility, but must not be presented as a secure command-execution boundary.

## Implementation sequence

### Phase 1 — Runtime contract
- Define Realm, Blueprint, execution request/result, resource policy, network policy, mount policy, capability report and typed errors.
- Add a backend interface with explicit capability reporting and no implicit host fallback.
- Add deterministic lifecycle state transitions and cleanup hooks.
- Keep the current MCP API backward compatible where safe; mark legacy host execution as trusted-host mode.

### Phase 2 — First enforced backend
Choose the first backend based on the platform being developed and tested. Prefer an OS-enforced backend over a home-grown security mechanism. A backend may use a system component as an implementation detail, but Envia must own policy validation, lifecycle, artifacts, audit, CLI and API semantics.
- Fail closed if prerequisites are unavailable.
- Disable networking by default using an enforceable backend mechanism.
- Restrict filesystem mounts and process privileges.
- Enforce CPU, memory, process, storage, time and output limits.
- Verify host-path denial, network denial, privilege restrictions and cleanup with real integration tests.
- Mocked unit tests do not count as proof of isolation.

### Phase 3 — Blueprints and reproducible artifacts
- Define a versioned declarative Blueprint format.
- Pin dependency inputs where feasible and record build metadata.
- Make snapshots content-addressed, bounded, validated and safely restorable.
- Clearly distinguish reproducibility guarantees from best-effort metadata.

### Phase 4 — CLI and developer workflow
- Ship a first-class CLI with human-readable and JSON output.
- Provide inspect, logs, exec/run, stop, destroy, snapshot and restore workflows.
- Produce actionable errors when a secure backend is unavailable.
- Add installation and update flows only after runtime prerequisites are understood.

### Phase 5 — Distribution and ecosystem
- Add a local Vault first; design a remote registry protocol later.
- Publish Blueprint examples and SDKs.
- Keep Mesh out of scope until a single-machine runtime is secure and reliable.

## Definition of done for the first runtime milestone
- No host execution fallback.
- A supported isolated backend can be detected and its capabilities explained.
- Real tests demonstrate filesystem boundary enforcement, default network denial, privilege reduction, resource limits, timeout handling, and cleanup.
- Tests explicitly distinguish mocked backend tests from real isolation tests.
- Existing MCP functionality remains covered by regression tests.
- README and CLI never describe a plain directory as a secure runtime.
- Build, lint, unit tests, and supported-backend integration tests pass.