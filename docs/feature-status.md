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
| Jailhouse orchestration | Planned |
| Registry | Planned |
| Agent Runs on jails | Implemented and tested (ledger, checkpoint, change gate, replay) |
| Secret redaction | Implemented and tested (configurable patterns and sensitive names) |
| Retention controls | Implemented and tested (preview, cleanup, disk usage) |
| Fault injection | Implemented (bounded best-effort and unsupported modes reported honestly) |
| Experiment intelligence | Implemented (hypothesis, evidence, conclusions, comparison, change verification) |