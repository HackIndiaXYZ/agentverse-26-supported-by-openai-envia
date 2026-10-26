export type ExperimentStatus = "created" | "running" | "completed" | "failed" | "cancelled" | "restored";

export interface ExperimentConfig {
  sourceProject: string;
  image?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  networkMode?: "none" | "host" | "bridge";
  networks?: string[];
  timeoutMs?: number;
  resourceLimits?: {
    cpuMillis?: number;
    memoryBytes?: number;
    pids?: number;
  };
  concurrencyLimit?: number;
}

export interface Checkpoint {
  id: string;
  experimentId: string;
  parentCheckpointId?: string;
  createdAt: string;
  path: string;
  sizeBytes: number;
  note?: string;
  fileManifest: Record<string, string>;
}

export interface ExperimentCommandResult {
  id: string;
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdout: string;
  stderr: string;
  stdoutHash: string;
  stderrHash: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  parentExperimentId?: string;
  parentCheckpointId?: string;
  sourceProject: string;
  sourceManifest: Record<string, string>;
  jailId?: string;
  rootDir?: string;
  config: ExperimentConfig;
  checkpoints: string[];
  commands: ExperimentCommandResult[];
  resultSummary?: string;
  ledgerPath: string;
  reportPath: string;
}