export interface AgentRunSpec {
  task: string;
  image?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  workingDirectory?: string;
  timeoutMs?: number;
  checkpoint?: boolean;
}

export interface AgentRunRecord {
  id: string;
  task: string;
  status: "running" | "succeeded" | "failed";
  createdAt: string;
  finishedAt?: string;
  jailId: string;
  spec: AgentRunSpec;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutHash: string;
  stderrHash: string;
  fileManifestHash: string;
  approved: boolean;
  checkpointPath?: string;
  reportPath: string;
  ledgerPath: string;
}