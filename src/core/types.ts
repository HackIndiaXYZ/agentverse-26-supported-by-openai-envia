export type SandboxId = string;
export type SnapshotId = string;

export interface SandboxPolicy {
  /** Whether the sandbox may reach the network. Advisory on platforms without OS-level isolation. */
  network: boolean;
  /** Extra host paths the sandbox is allowed to read/write. Paths are validated, not enforced by OS. */
  allowedPaths?: string[];
  /** Hard timeout for a single run in milliseconds. */
  maxRuntimeMs?: number;
  /** Maximum captured stdout/stderr bytes per run. */
  maxOutputBytes?: number;
  /** Extra environment variables injected into runs. */
  env?: Record<string, string>;
}

export interface Sandbox {
  id: SandboxId;
  name: string;
  rootDir: string;
  policy: SandboxPolicy;
  createdAt: string;
  status: "active" | "destroyed";
}

export interface RunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  sandboxId: SandboxId;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface Snapshot {
  id: SnapshotId;
  sandboxId: SandboxId;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

export interface AuditEntry {
  ts: string;
  sandboxId?: SandboxId;
  action: string;
  detail: Record<string, unknown>;
  ok: boolean;
  error?: string;
}