import type { EvaluationConfig, EvaluationReport } from "../evaluation/types.js";

export type CampaignStatus = "planned" | "ready" | "running" | "evaluating" | "completed" | "failed" | "cancelled" | "blocked" | "interrupted";

export interface CampaignExperimentDefinition {
  name: string;
  hypothesis?: string;
  objective?: string;
  method?: string;
  expectedOutcome?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  resourceLimits?: { cpuMillis?: number; memoryBytes?: number; pids?: number };
}

export interface CampaignExperiment {
  name: string;
  experimentId?: string;
  hypothesis?: string;
  objective?: string;
  method?: string;
  expectedOutcome?: string;
  status: string;
  baselineCheckpointId?: string;
}

export interface CampaignRecoveryAttempt {
  id: string;
  experimentId: string;
  attempt: number;
  classification: string;
  hypothesis: string;
  appliedChanges: string[];
  verificationExitCode: number | null;
  outcome: "succeeded" | "failed" | "stopped";
  startedAt: string;
  endedAt: string;
  notes: string;
}

export interface CampaignCandidate {
  experimentId: string;
  selectedAt: string;
  verificationHash?: string;
  approved?: boolean;
  approvalReason?: string;
  approvedAt?: string;
  patchPath?: string;
  promoted?: boolean;
  promotedAt?: string;
}

export interface CampaignComparison {
  leftId: string;
  rightId: string;
  summary: string;
  comparable: boolean;
  details: Record<string, unknown>;
}

export interface CampaignRecord {
  id: string;
  name: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  sourceProject: string;
  sourceManifest: Record<string, string>;
  objective: string;
  successCriteria?: string;
  maxConcurrency: number;
  experiments: CampaignExperiment[];
  baselineCheckpointIds: Record<string, string>;
  comparison?: CampaignComparison[];
  candidate?: CampaignCandidate;
  recoveryAttempts: CampaignRecoveryAttempt[];
  report?: Record<string, unknown>;
  failure?: string;
  evaluationConfig?: EvaluationConfig;
  evaluations?: EvaluationReport[];
  plan?: CampaignPlan;
}

export interface CampaignRecommendation {
  type: string;
  priority: number;
  reason: string;
  evidence: string[];
  suggestedTool?: string;
  requiresApproval?: boolean;
}

export interface CampaignPlanExperiment {
  name: string;
  hypothesis?: string;
  objective?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  resourceLimits?: { cpuMillis?: number; memoryBytes?: number; pids?: number };
}

export interface CampaignPlan {
  version: string;
  objective: string;
  acceptanceCriteria: string[];
  experiments: CampaignPlanExperiment[];
  evaluationCriteria?: string[];
  resourceBudget?: { maxConcurrency?: number; timeoutMs?: number };
  attemptBudget?: { maxAttempts?: number };
  stopConditions: string[];
  approvalRequired: boolean;
  approved?: boolean;
  approvedAt?: string;
  approvalReason?: string;
  deviations?: string[];
}