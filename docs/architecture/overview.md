# Envia Architecture Overview

Envia is an independent container platform with replaceable layers. The current repository contains the first runtime foundation plus the existing MCP server, sandbox manager, Claude Code plugin, and security tests.

## Layers

- CLI and machine-readable output
- Runtime contract and capability discovery
- Isolation backends
- Persistent state and operation journal
- Storage, images, and registries
- Networking
- Jailhouse orchestration
- Agent-native execution and recovery
- MCP and plugin integrations

## Current implementation status

The first runtime foundation implements:

- A backend interface and capability matrix
- A host-process development backend that is explicitly non-isolated
- Persistent jail records and operation journaling
- Create, list, inspect, start, stop, and remove operations
- Honest reporting when required isolation is unavailable

It does not yet implement OS-level isolation, image builds, networking, registries, or Jailhouse. Those remain planned.