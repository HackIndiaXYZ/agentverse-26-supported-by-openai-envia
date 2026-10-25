export type IsolationLevel = "enforced" | "best-effort" | "unsupported";

export interface CapabilityMatrix {
  isolation: IsolationLevel;
  network: IsolationLevel;
  resourceLimits: IsolationLevel;
  interactiveTerminal: boolean;
  pauseResume: boolean;
  checkpoint: boolean;
}

export interface JailLimits {
  cpuMillis?: number;
  memoryBytes?: number;
  pids?: number;
  diskBytes?: number;
  runtimeMs?: number;
}

export interface JailMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface JailSpec {
  name: string;
  backend?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  mounts?: JailMount[];
  limits?: JailLimits;
  networkMode?: "none" | "host" | "bridge";
  isolationRequired?: boolean;
  allowUnsafeHostProcess?: boolean;
}

export type JailState = "created" | "running" | "stopped" | "failed" | "removed";

export interface JailRecord {
  id: string;
  name: string;
  backend: string;
  spec: JailSpec;
  state: JailState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  pid?: number | null;
  exitCode?: number | null;
  rootDir: string;
  logPath: string;
}

export interface OperationJournalEntry {
  id: string;
  timestamp: string;
  operation: string;
  jailId?: string;
  detail: Record<string, unknown>;
  result: "success" | "failure";
  error?: string;
}

export interface RuntimeBackend {
  name: string;
  capabilities(): CapabilityMatrix;
  createJail(spec: JailSpec): Promise<JailRecord>;
  startJail(jail: JailRecord): Promise<JailRecord>;
  inspectJail(jail: JailRecord): Promise<JailRecord>;
  listJails(): Promise<JailRecord[]>;
  stopJail(jail: JailRecord, timeoutMs?: number): Promise<JailRecord>;
  removeJail(jail: JailRecord): Promise<void>;
  logs(jail: JailRecord, lines?: number): Promise<string[]>;
}