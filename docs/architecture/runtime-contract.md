# Runtime Contract

## Jail specification

A jail is created from a `JailSpec` containing:

- `name`
- `backend`
- `image` (optional for the first foundation)
- `command` and `args`
- `environment`
- `workingDirectory`
- `mounts`
- `limits`
- `networkMode`
- `isolationRequired` (default true)

## Backend capability matrix

Each backend reports:

- `isolation`: `enforced`, `best-effort`, or `unsupported`
- `network`: `enforced`, `best-effort`, or `unsupported`
- `resourceLimits`: `enforced`, `best-effort`, or `unsupported`
- `interactiveTerminal`
- `pauseResume`
- `checkpoint`

If a requested jail has `isolationRequired: true` and the backend cannot enforce isolation, creation must fail. Envia must not silently fall back to unrestricted host execution.

## Host-process development backend

The initial backend is `host-process`. It is explicitly a development and test backend. It does not provide filesystem, process, or network isolation. It must only be used with `isolationRequired: false` or an explicit unsafe override. Its capability matrix reports isolation as `unsupported`.