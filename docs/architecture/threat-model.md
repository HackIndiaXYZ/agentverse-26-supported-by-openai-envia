# Threat Model

## Threats

- Malicious code inside a jail.
- Jail escape attempts.
- Malicious build inputs and Jailfiles.
- Symlink and path traversal attacks.
- Malicious archive extraction.
- Resource exhaustion.
- Network exfiltration.
- Credential theft.
- Registry compromise.
- Malicious images and dependencies.
- Concurrent lifecycle operations.
- Crashes and incomplete cleanup.
- Compromised AI agents and prompt injection.
- Malicious or compromised plugins.
- Privileged host users and kernel vulnerabilities.

## Current defenses

- Filesystem path canonicalization and symlink checks in the sandbox manager.
- Default-deny host command execution.
- Bounded output, file sizes, timeouts, and snapshot sizes.
- Archive validation and staged restore.
- Append-only audit logging.
- Capability reporting that marks host-process isolation as unsupported.

## Remaining risks

- No OS-level isolation in the current backend.
- Network controls are advisory unless a stronger backend is selected.
- Trusted-host execution is not isolated.
- A host administrator can alter local state and logs.