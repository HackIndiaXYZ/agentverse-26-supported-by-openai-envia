export type TransactionState =
  | "prepared"
  | "applying"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "recovery_required"
  | "failed";

export interface TransactionOperation {
  type: "write" | "delete";
  relativePath: string;
}

export interface TransactionFileState {
  relativePath: string;
  existed: boolean;
  originalHash?: string;
  backupPath?: string;
  stagedPath?: string;
  candidateHash?: string;
}

export interface TransactionRecord {
  id: string;
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  campaignId?: string;
  experimentId?: string;
  candidateSelectedAt?: string;
  sourceProject: string;
  sourceProjectIdentity: string;
  baselineCheckpointId?: string;
  baselineManifestHash?: string;
  verificationHash?: string;
  operations: TransactionOperation[];
  files: TransactionFileState[];
  completedOperations: string[];
  rollbackCompleted: string[];
  failure?: string;
}