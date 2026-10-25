# Envia Security Evaluation

This document summarizes adversarial tests and their outcomes. Tests live in `tests/security.test.ts`.

| Threat | Test | Expected | Actual | Status |
|---|---|---|---|---|
| Host command execution by default | `Security: host execution default` | Rejected with "disabled by default" | Rejected and audited | Pass |
| Path traversal in read | `Security: path traversal` | Rejected | Rejected | Pass |
| Path traversal in write | `Security: path traversal` | Rejected | Rejected | Pass |
| Path traversal in list | `Security: path traversal` | Rejected | Rejected | Pass |
| Absolute path outside sandbox | `Security: path traversal` | Rejected | Rejected | Pass |
| Embedded `..` segments | `Security: path traversal` | Rejected | Rejected | Pass |
| NUL byte in path | `Security: path traversal` | Rejected | Rejected | Pass |
| Symlink read escape | `Security: symlink escape` | Rejected | Rejected (where link creation is permitted) | Pass |
| Symlink write escape | `Security: symlink escape` | Rejected | Rejected (where link creation is permitted) | Pass |
| Invalid snapshot id | `Security: snapshots` | Rejected | Rejected | Pass |
| Corrupted snapshot metadata | `Security: snapshots` | Rejected | Rejected | Pass |
| Path traversal in snapshot archive | `Security: snapshots` | Rejected | Rejected | Pass |
| Symlink entry in snapshot archive | `Security: snapshots` | Rejected | Rejected | Pass |
| Oversized snapshot | `Security: snapshots` | Rejected | Rejected | Pass |
| Oversized restore archive | `Security: snapshots` | Rejected | Rejected | Pass |
| Command timeout | `Security: command execution` | `timedOut === true` | Timed out and killed | Pass |
| Large command output | `Security: command execution` | Truncated and bounded | Truncated | Pass |
| Failed command audit | `Security: command execution` | Audit entry with `ok: false` | Recorded | Pass |
| Dangerous environment variable | `Security: command execution` | Rejected | Rejected | Pass |
| Failed file read audit | `Security: audit` | Audit entry with `ok: false` | Recorded | Pass |
| Sandbox destruction cleanup | `Security: cleanup` | Files removed | Removed | Pass |
| Malformed audit lines | `Security: cleanup` | Skipped, array returned | Skipped | Pass |

Not tested in this environment:
- OS-level network isolation (not implemented).
- TOCTOU symlink races under adversarial concurrent processes.
- Real Claude Code plugin runtime execution.