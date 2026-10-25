export type SandboxId = string;
export type SnapshotId = string;

export type ExecutionMode = "disabled" | "trusted-host";

export interface SandboxPolicy {
  /** Whether the sandbox may reach the network. Advisory only unless a real backend enforces it. */
  network: boolean;
  /** Extra host paths explicitly granted to the sandbox. Empty by default. */
  allowedPaths: string[];
  /** Hard timeout for a single run in milliseconds. */
  maxRuntimeMs: number;
  /** Maximum captured stdout/stderr bytes per run. */
  maxOutputBytes: number;
  /** Maximum bytes for a single file write. */
  maxFileBytes: number;
  /** Maximum snapshot archive size in bytes. */
  maxSnapshotBytes: number;
  /** Extra environment variables injected into runs. */
  env: Record<string, string>;
  /** Whether host command execution is permitted for this sandbox. */
  allowHostCommands: boolean;
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
  executionMode: ExecutionMode;
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