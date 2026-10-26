export type MeasurementStatus = "measured" | "inferred" | "unavailable" | "not-applicable";

export type CriterionScoring =
  | "higher-is-better"
  | "lower-is-better"
  | "boolean-pass"
  | "threshold"
  | "informational";

export interface EvaluationCriterion {
  id: string;
  label: string;
  weight: number;
  mandatory?: boolean;
  dataSource: string;
  scoring: CriterionScoring;
  threshold?: number;
  maxScore?: number;
}

export interface EvaluationConfig {
  version: string;
  criteria: EvaluationCriterion[];
}

export interface EvidenceMeasurement {
  criterionId: string;
  status: MeasurementStatus;
  value?: unknown;
  source?: string;
  details?: string;
}

export interface CriterionResult {
  criterionId: string;
  label: string;
  weight: number;
  mandatory: boolean;
  dataSource: string;
  scoring: CriterionScoring;
  status: MeasurementStatus;
  score: number | null;
  maxScore: number;
  evidence: EvidenceMeasurement[];
  reason: string;
}

export interface CandidateEvaluation {
  experimentId: string;
  name: string;
  overallScore: number | null;
  complete: boolean;
  confidence: "high" | "medium" | "low" | "unknown";
  criteria: CriterionResult[];
  missingEvidence: string[];
  regressions: string[];
  measuredValues: Record<string, unknown>;
}

export interface EvaluationRankingEntry {
  experimentId: string;
  name: string;
  rank: number;
  overallScore: number | null;
  complete: boolean;
  confidence: CandidateEvaluation["confidence"];
  missingEvidenceCount: number;
  regressionCount: number;
}

export interface EvaluationIncomparability {
  leftId: string;
  rightId: string;
  reason: string;
}

export interface EvaluationReport {
  campaignId: string;
  generatedAt: string;
  configVersion: string;
  policyVersion: string;
  candidates: CandidateEvaluation[];
  ranking: EvaluationRankingEntry[];
  incomparable: EvaluationIncomparability[];
  summary: string;
}

export interface ComparisonPolicy {
  functionalCorrectnessMandatory: boolean;
  noRegressionOutranksPerformance: boolean;
  missingTestsNotPass: boolean;
  requireEquivalentWorkloads: boolean;
}

export const DEFAULT_COMPARISON_POLICY: ComparisonPolicy = {
  functionalCorrectnessMandatory: true,
  noRegressionOutranksPerformance: true,
  missingTestsNotPass: true,
  requireEquivalentWorkloads: true,
};

export interface ExperimentEvidence {
  testResults?: Array<{ name: string; passed: boolean; details?: string }>;
  build?: { status: "passed" | "failed" | "skipped"; command?: string; details?: string };
  typeCheck?: { status: "passed" | "failed" | "skipped"; command?: string; details?: string };
  regressions?: string[];
  changedFiles?: string[];
  commandFailures?: number;
  commandCount?: number;
  reproducibility?: { repeatedRuns: number; consistent: boolean; details?: string };
  performance?: { workloadId?: string; durationMs?: number; score?: number; details?: string };
  resourceUsage?: { cpuMs?: number; memoryBytes?: number; details?: string };
  objectiveMet?: boolean | null;
  missingTests?: string[];
  notes?: string[];
}
