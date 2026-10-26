# Feature Status

| Feature | Status |
|---|---|
| MCP server and sandbox tools | Implemented and tested |
| Claude Code plugin manifest | Implemented and validated |
| Host-process runtime backend | Implemented and tested |
| Jail lifecycle state persistence | Implemented and tested |
| Operation journal | Implemented and tested |
| OS-level isolation backend | Implemented for Linux (unshare namespaces; best-effort resource limits); unsupported on Windows |
| Jailfile builds | Implemented and tested (host-process execution for RUN; no OS isolation) |
| Images and layers | Implemented and tested (content-addressed image store, tags, cache, import/export) |
| Jail lifecycle (exec, restart, run, logs) | Implemented and tested on host-process backend |
| Volumes and mounts | Implemented and tested (named volumes, bind mounts via hard links/junctions; best-effort) |
| Networking registry | Implemented (metadata only; enforcement unsupported) |
| Isolated networking | Implemented for Linux network namespaces in `none` mode; host mode is not isolated |
| Jailhouse orchestration | Implemented and tested (multi-service startup, dependencies, volumes, networks, logs, teardown) |
| Registry | Planned |
| Agent Runs on jails | Implemented and tested (ledger, checkpoint, change gate, replay) |
| Secret redaction | Implemented and tested (configurable patterns and sensitive names) |
| Retention controls | Implemented and tested (preview, cleanup, disk usage) |
| Fault injection | Implemented (bounded best-effort and unsupported modes reported honestly) |
| Experiment intelligence | Implemented (hypothesis, evidence, conclusions, comparison, change verification) |
| Evidence-based evaluation | Implemented and tested (configurable criteria, deterministic scoring, missing evidence, ranking, policy) |
| Failure forensics | Implemented (redacted command, ledger, fault, recovery, and signature correlation) |
| Next-experiment recommendations | Implemented (deterministic recommendations from campaign state) |
| Bounded campaign planning | Implemented (validated plans, approval, deviation tracking) |
| Agent experiment campaigns | Implemented and tested (lifecycle, bounded concurrency, cancellation, locking, candidate workflow); verified on Windows host-process backend; concurrency tested with serial and bounded workers |
| Bounded recovery loop | Implemented and tested (injectable provider, attempt budgets, persisted history, unsafe-path rejection, malformed-output handling); timeout enforcement is cooperative and provider cancellation is best-effort |
| Source-project protection | Tested for checkpoint restore, journaled candidate application, rollback, and recovery path containment; direct application requires approval and confirmation; multi-file application is recoverable but not globally atomic |
| Application transactions | Implemented and tested for successful multi-file application, rollback, and crash recovery; transaction journals and backups are preserved when recovery is required |
| Cross-process coordination | Implemented with Windows-compatible file locks for campaigns, experiments, recovery, and candidate application; separate-process contention tests are limited |
| Windows host-process backend | Verified as non-isolated development backend only; not a secure OS-level sandbox |
| Linux namespace backend | Implemented but unverified on this Windows host; out of scope for this milestone |
| Networking | Metadata and Linux bridge implementation exist; enforcement unsupported on host-process backend |
| Retention cleanup | Implemented and tested for managed paths; symlink/junction edge cases remain best-effort |
| Secret redaction | Implemented and tested for common patterns; pattern-based and cannot detect every secret; historical records are not rewritten |