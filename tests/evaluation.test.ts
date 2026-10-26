import { describe, expect, it } from "vitest";
import { EvaluationEngine, DEFAULT_EVALUATION_CONFIG } from "../src/evaluation/engine.js";
import type { ExperimentEvidence } from "../src/evaluation/types.js";

describe("EvaluationEngine", () => {
  const engine = new EvaluationEngine();

  it("scores identical evidence deterministically", () => {
    const evidence: ExperimentEvidence = {
      testResults: [{ name: "unit", passed: true }],
      build: { status: "passed" },
      typeCheck: { status: "passed" },
      regressions: [],
      commandFailures: 0,
      commandCount: 1,
    };
    const first = engine.evaluateCandidate(DEFAULT_EVALUATION_CONFIG, "exp-1", "candidate", evidence);
    const second = engine.evaluateCandidate(DEFAULT_EVALUATION_CONFIG, "exp-1", "candidate", evidence);
    expect(first).toEqual(second);
    expect(first.overallScore).toBe(100);
    expect(first.complete).toBe(true);
  });

  it("marks missing mandatory evidence as incomplete and unscored", () => {
    const evidence: ExperimentEvidence = {
      testResults: [{ name: "unit", passed: true }],
    };
    const result = engine.evaluateCandidate(DEFAULT_EVALUATION_CONFIG, "exp-1", "candidate", evidence);
    expect(result.complete).toBe(false);
    expect(result.overallScore).toBeNull();
    expect(result.missingEvidence.length).toBeGreaterThan(0);
  });

  it("penalizes regressions", () => {
    const evidence: ExperimentEvidence = {
      testResults: [{ name: "unit", passed: true }],
      build: { status: "passed" },
      typeCheck: { status: "passed" },
      regressions: ["breaks existing behavior"],
      commandFailures: 0,
      commandCount: 1,
    };
    const result = engine.evaluateCandidate(DEFAULT_EVALUATION_CONFIG, "exp-1", "candidate", evidence);
    const regressionCriterion = result.criteria.find((c) => c.criterionId === "regressions");
    expect(regressionCriterion?.score).toBe(0);
    expect(result.regressions).toEqual(["breaks existing behavior"]);
  });

  it("validates configuration", () => {
    const errors = engine.validateConfig({ version: "", criteria: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("ranks complete candidates above incomplete ones", () => {
    const complete = engine.evaluateCandidate(DEFAULT_EVALUATION_CONFIG, "exp-1", "complete", {
      testResults: [{ name: "unit", passed: true }],
      build: { status: "passed" },
      typeCheck: { status: "passed" },
      regressions: [],
      commandFailures: 0,
      commandCount: 1,
    });
    const incomplete = engine.evaluateCandidate(DEFAULT_EVALUATION_CONFIG, "exp-2", "incomplete", {});
    const report = engine.evaluateCampaign(DEFAULT_EVALUATION_CONFIG, "camp-1", [
      { experimentId: "exp-2", name: "incomplete", evidence: {} },
      { experimentId: "exp-1", name: "complete", evidence: {
        testResults: [{ name: "unit", passed: true }],
        build: { status: "passed" },
        typeCheck: { status: "passed" },
        regressions: [],
        commandFailures: 0,
        commandCount: 1,
      } },
    ]);
    expect(report.ranking[0].experimentId).toBe("exp-1");
    expect(complete.overallScore).toBe(100);
    expect(incomplete.overallScore).toBeNull();
  });
});
