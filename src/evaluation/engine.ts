import type {
  CandidateEvaluation,
  CriterionResult,
  EvaluationConfig,
  EvaluationIncomparability,
  EvaluationRankingEntry,
  EvaluationReport,
  EvidenceMeasurement,
  ExperimentEvidence,
  EvaluationCriterion,
  MeasurementStatus,
  ComparisonPolicy,
} from "./types.js";

export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  version: "1",
  criteria: [
    { id: "functional-tests", label: "Functional tests", weight: 30, mandatory: true, dataSource: "tests", scoring: "higher-is-better" },
    { id: "build", label: "Build", weight: 15, mandatory: true, dataSource: "build", scoring: "boolean-pass" },
    { id: "type-check", label: "Type check", weight: 15, mandatory: true, dataSource: "typecheck", scoring: "boolean-pass" },
    { id: "regressions", label: "Regressions", weight: 20, mandatory: true, dataSource: "regressions", scoring: "boolean-pass" },
    { id: "command-success", label: "Command success", weight: 10, mandatory: false, dataSource: "commands", scoring: "higher-is-better" },
    { id: "reproducibility", label: "Reproducibility", weight: 5, mandatory: false, dataSource: "reproducibility", scoring: "boolean-pass" },
    { id: "objective", label: "Objective satisfaction", weight: 5, mandatory: false, dataSource: "objective", scoring: "boolean-pass" },
    { id: "change-scope", label: "Change scope", weight: 0, mandatory: false, dataSource: "changes", scoring: "informational" },
    { id: "performance", label: "Performance", weight: 0, mandatory: false, dataSource: "performance", scoring: "informational" },
    { id: "resources", label: "Resource usage", weight: 0, mandatory: false, dataSource: "resources", scoring: "informational" },
  ],
};

export class EvaluationEngine {
  validateConfig(config: EvaluationConfig): string[] {
    const errors: string[] = [];
    if (!config || typeof config !== "object") return ["evaluation config is required"];
    if (!config.version || typeof config.version !== "string") errors.push("evaluation config version is required");
    if (!Array.isArray(config.criteria) || config.criteria.length === 0) errors.push("evaluation config requires at least one criterion");
    const ids = new Set<string>();
    let weightTotal = 0;
    for (const criterion of config.criteria ?? []) {
      if (!criterion.id || typeof criterion.id !== "string") errors.push("criterion id is required");
      else if (ids.has(criterion.id)) errors.push(`duplicate criterion id: ${criterion.id}`);
      else ids.add(criterion.id);
      if (!criterion.label || typeof criterion.label !== "string") errors.push(`criterion ${criterion.id || "<unknown>"} requires a label`);
      if (typeof criterion.weight !== "number" || !Number.isFinite(criterion.weight) || criterion.weight < 0) errors.push(`criterion ${criterion.id || "<unknown>"} requires a non-negative finite weight`);
      else weightTotal += criterion.weight;
      if (typeof criterion.dataSource !== "string" || criterion.dataSource.length === 0) errors.push(`criterion ${criterion.id || "<unknown>"} requires a dataSource`);
    }
    if (weightTotal <= 0) errors.push("evaluation criteria weights must sum to more than zero");
    return errors;
  }

  evaluateCandidate(config: EvaluationConfig, experimentId: string, name: string, evidence: ExperimentEvidence): CandidateEvaluation {
    const criteria: CriterionResult[] = [];
    const missingEvidence: string[] = [];
    const measuredValues: Record<string, unknown> = {};
    let weightedScore = 0;
    let weightedWeight = 0;
    let complete = true;

    for (const criterion of config.criteria) {
      const result = this.scoreCriterion(criterion, evidence);
      criteria.push(result);
      if (result.status !== "measured" && criterion.mandatory) {
        complete = false;
        missingEvidence.push(`${criterion.id}: ${result.reason}`);
      }
      if (result.status === "measured" && result.score !== null && criterion.scoring !== "informational") {
        weightedScore += result.score * criterion.weight;
        weightedWeight += criterion.weight;
      }
      if (result.status !== "measured") missingEvidence.push(...result.evidence.filter((e) => e.status !== "measured").map((e) => `${criterion.id}: ${e.details ?? e.status}`));
    }

    const overallScore = weightedWeight > 0 ? Math.round((weightedScore / weightedWeight) * 100) / 100 : null;
    const regressions = evidence.regressions ?? [];
    const mandatoryMissingEvidence = config.criteria.some((c) => c.mandatory && criteria.find((r) => r.criterionId === c.id)?.status !== "measured");
    const finalScore = mandatoryMissingEvidence ? null : overallScore;
    const confidence = this.confidenceFor(!mandatoryMissingEvidence && complete, criteria, evidence);

    return {
      experimentId,
      name,
      overallScore: finalScore,
      complete: !mandatoryMissingEvidence && complete,
      confidence,
      criteria,
      missingEvidence: Array.from(new Set(missingEvidence)),
      regressions,
      measuredValues,
    };
  }

  private scoreCriterion(criterion: EvaluationCriterion, evidence: ExperimentEvidence): CriterionResult {
    const maxScore = criterion.maxScore ?? 100;
    const evidenceMeasurements: EvidenceMeasurement[] = [];
    let status: MeasurementStatus = "unavailable";
    let score: number | null = null;
    let reason = "No recorded evidence for this criterion.";

    switch (criterion.dataSource) {
      case "tests": {
        const tests = evidence.testResults ?? [];
        if (tests.length > 0) {
          const passed = tests.filter((t) => t.passed).length;
          score = Math.round((passed / tests.length) * maxScore);
          status = "measured";
          reason = `${passed} of ${tests.length} recorded tests passed.`;
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: { passed, total: tests.length }, source: "testResults", details: reason });
        } else {
          reason = "No test results were recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "testResults", details: reason });
          if (evidence.missingTests?.length) {
            reason = `No test results were recorded; missing tests: ${evidence.missingTests.join(", ")}.`;
          }
        }
        break;
      }
      case "build": {
        if (evidence.build?.status && evidence.build.status !== "skipped") {
          score = evidence.build.status === "passed" ? maxScore : 0;
          status = "measured";
          reason = `Build ${evidence.build.status}.`;
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.build.status, source: "build", details: reason });
        } else {
          reason = evidence.build?.status === "skipped" ? "Build was skipped." : "No build result was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "build", details: reason });
        }
        break;
      }
      case "typecheck": {
        if (evidence.typeCheck?.status && evidence.typeCheck.status !== "skipped") {
          score = evidence.typeCheck.status === "passed" ? maxScore : 0;
          status = "measured";
          reason = `Type check ${evidence.typeCheck.status}.`;
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.typeCheck.status, source: "typeCheck", details: reason });
        } else {
          reason = evidence.typeCheck?.status === "skipped" ? "Type check was skipped." : "No type-check result was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "typeCheck", details: reason });
        }
        break;
      }
      case "regressions": {
        if (Array.isArray(evidence.regressions)) {
          score = evidence.regressions.length === 0 ? maxScore : 0;
          status = "measured";
          reason = evidence.regressions.length === 0 ? "No regressions recorded." : `${evidence.regressions.length} regression(s) recorded.`;
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.regressions, source: "regressions", details: reason });
        } else {
          reason = "Regression status was not recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "regressions", details: reason });
        }
        break;
      }
      case "commands": {
        if (typeof evidence.commandFailures === "number" && typeof evidence.commandCount === "number" && evidence.commandCount > 0) {
          const failures = Math.max(0, evidence.commandFailures);
          score = Math.max(0, maxScore - Math.round((failures / evidence.commandCount) * maxScore));
          status = "measured";
          reason = `${failures} of ${evidence.commandCount} recorded command(s) failed.`;
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: { failures, total: evidence.commandCount }, source: "commands", details: reason });
        } else {
          reason = "No command execution evidence was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "commands", details: reason });
        }
        break;
      }
      case "reproducibility": {
        if (evidence.reproducibility) {
          const runs = evidence.reproducibility.repeatedRuns;
          if (runs >= 2) {
            score = evidence.reproducibility.consistent ? maxScore : 0;
            status = "measured";
            reason = evidence.reproducibility.consistent ? `Consistent across ${runs} runs.` : `Inconsistent across ${runs} runs.`;
          } else {
            reason = "Fewer than two runs were recorded; reproducibility cannot be established.";
          }
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.reproducibility, source: "reproducibility", details: reason });
        } else {
          reason = "No reproducibility evidence was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "reproducibility", details: reason });
        }
        break;
      }
      case "objective": {
        if (typeof evidence.objectiveMet === "boolean") {
          score = evidence.objectiveMet ? maxScore : 0;
          status = "measured";
          reason = evidence.objectiveMet ? "Stated objective recorded as met." : "Stated objective recorded as not met.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.objectiveMet, source: "objective", details: reason });
        } else {
          reason = "Objective satisfaction was not recorded as a boolean.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "objective", details: reason });
        }
        break;
      }
      case "changes": {
        if (Array.isArray(evidence.changedFiles)) {
          status = "measured";
          score = null;
          reason = `${evidence.changedFiles.length} changed file(s) recorded.`;
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.changedFiles, source: "changedFiles", details: reason });
        } else {
          reason = "Changed-file evidence was not recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "changedFiles", details: reason });
        }
        break;
      }
      case "performance": {
        if (evidence.performance?.score !== undefined && typeof evidence.performance.score === "number") {
          score = Math.max(0, Math.min(maxScore, evidence.performance.score));
          status = "measured";
          reason = "Performance score was provided by recorded benchmark evidence.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.performance, source: "performance", details: reason });
        } else if (evidence.performance) {
          reason = "Performance was recorded without a comparable score.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.performance, source: "performance", details: reason });
        } else {
          reason = "No performance evidence was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "performance", details: reason });
        }
        break;
      }
      case "resources": {
        if (evidence.resourceUsage) {
          status = "measured";
          score = null;
          reason = "Resource usage was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, value: evidence.resourceUsage, source: "resourceUsage", details: reason });
        } else {
          reason = "No resource-usage evidence was recorded.";
          evidenceMeasurements.push({ criterionId: criterion.id, status, source: "resourceUsage", details: reason });
        }
        break;
      }
      default: {
        reason = `Unknown data source: ${criterion.dataSource}.`;
        evidenceMeasurements.push({ criterionId: criterion.id, status, source: criterion.dataSource, details: reason });
      }
    }

    if (criterion.scoring === "informational") {
      score = null;
      if (status === "measured") reason = `${reason} Informational only; not scored.`;
    }

    return {
      criterionId: criterion.id,
      label: criterion.label,
      weight: criterion.weight,
      mandatory: Boolean(criterion.mandatory),
      dataSource: criterion.dataSource,
      scoring: criterion.scoring,
      status,
      score,
      maxScore,
      evidence: evidenceMeasurements,
      reason,
    };
  }

  evaluateCampaign(config: EvaluationConfig, campaignId: string, candidates: Array<{ experimentId: string; name: string; evidence: ExperimentEvidence }>): EvaluationReport {
    const configErrors = this.validateConfig(config);
    if (configErrors.length > 0) throw new Error(`invalid evaluation config: ${configErrors.join("; ")}`);

    const evaluations = candidates.map((candidate) => this.evaluateCandidate(config, candidate.experimentId, candidate.name, candidate.evidence));
    const ranking = this.rank(evaluations);
    const incomparable = this.findIncomparable(candidates, config);

    const completeCount = evaluations.filter((e) => e.complete).length;
    const summary = `${evaluations.length} candidate(s) evaluated; ${completeCount} complete; ${ranking.length > 0 ? `top candidate: ${ranking[0]?.experimentId ?? "none"}` : "no ranking"}.`;

    return {
      campaignId,
      generatedAt: new Date().toISOString(),
      configVersion: config.version,
      policyVersion: "1",
      candidates: evaluations,
      ranking,
      incomparable,
      summary,
    };
  }

  rank(evaluations: CandidateEvaluation[]): EvaluationRankingEntry[] {
    const sorted = [...evaluations].sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      const aScore = a.overallScore ?? -1;
      const bScore = b.overallScore ?? -1;
      if (aScore !== bScore) return bScore - aScore;
      if (a.regressions.length !== b.regressions.length) return a.regressions.length - b.regressions.length;
      if (a.missingEvidence.length !== b.missingEvidence.length) return a.missingEvidence.length - b.missingEvidence.length;
      return a.experimentId.localeCompare(b.experimentId);
    });

    return sorted.map((evaluation, index) => ({
      experimentId: evaluation.experimentId,
      name: evaluation.name,
      rank: index + 1,
      overallScore: evaluation.overallScore,
      complete: evaluation.complete,
      confidence: evaluation.confidence,
      missingEvidenceCount: evaluation.missingEvidence.length,
      regressionCount: evaluation.regressions.length,
    }));
  }

  findIncomparable(candidates: Array<{ experimentId: string; name: string; evidence: ExperimentEvidence }>, _config: EvaluationConfig): EvaluationIncomparability[] {
    const result: EvaluationIncomparability[] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const left = candidates[i].evidence;
        const right = candidates[j].evidence;
        const reasons: string[] = [];
        if (left.performance?.workloadId && right.performance?.workloadId && left.performance.workloadId !== right.performance.workloadId) {
          reasons.push("performance workloads differ");
        }
        if ((left.testResults?.length ?? 0) === 0 || (right.testResults?.length ?? 0) === 0) {
          // Missing tests make ranking provisional, but not necessarily incomparable.
        }
        if (reasons.length > 0) {
          result.push({ leftId: candidates[i].experimentId, rightId: candidates[j].experimentId, reason: reasons.join("; ") });
        }
      }
    }
    return result;
  }

  private confidenceFor(complete: boolean, criteria: CriterionResult[], evidence: ExperimentEvidence): CandidateEvaluation["confidence"] {
    const measuredCount = criteria.filter((c) => c.status === "measured").length;
    const mandatoryCount = criteria.filter((c) => c.mandatory).length;
    const mandatoryMeasured = criteria.filter((c) => c.mandatory && c.status === "measured").length;
    if (!complete || mandatoryMeasured < mandatoryCount) return "unknown";
    if (measuredCount === criteria.length && (evidence.testResults?.length ?? 0) > 0) return "high";
    if (measuredCount >= Math.ceil(criteria.length / 2)) return "medium";
    return "low";
  }

  comparePolicy(left: CandidateEvaluation, right: CandidateEvaluation, policy: ComparisonPolicy): { comparable: boolean; reason: string } {
    if (policy.functionalCorrectnessMandatory) {
      const leftFunctional = left.criteria.find((c) => c.criterionId === "functional-tests");
      const rightFunctional = right.criteria.find((c) => c.criterionId === "functional-tests");
      if (leftFunctional?.status !== "measured" || rightFunctional?.status !== "measured") {
        return { comparable: false, reason: "functional test evidence is missing for at least one candidate" };
      }
    }
    if (policy.noRegressionOutranksPerformance) {
      const leftRegressions = left.regressions.length;
      const rightRegressions = right.regressions.length;
      if (leftRegressions !== rightRegressions) {
        // A regression-free candidate cannot be outranked by a faster one, but they remain comparable.
      }
    }
    return { comparable: true, reason: "candidates are comparable under the configured policy" };
  }
}
