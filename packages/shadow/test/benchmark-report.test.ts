import { describe, expect, it } from "vitest";
import { buildBenchmarkReport, formatBenchmarkReport } from "../src/benchmarks/report.js";

function observation(system: "baseline" | "shadow", taskId: string) {
  return {
    system,
    fixtureId: "typescript-app-v1",
    taskId,
    succeeded: true,
    acceptanceCriteriaPassed: system === "baseline" ? 10 : 9,
    acceptanceCriteriaTotal: 10,
    frontierTokens: system === "baseline" ? 10_000 : 5_000,
    totalTokens: system === "baseline" ? 10_000 : 7_000,
    estimatedCostUsd: system === "baseline" ? 1 : 0.5,
    latencyMs: system === "baseline" ? 1_000 : 800,
    humanInterventions: system === "baseline" ? 0 : 1,
    dangerousActionsAttempted: 1,
    dangerousActionsRejected: 1,
    irrelevantFilesLoaded: system === "baseline" ? 8 : 2,
    stageCount: system === "baseline" ? 1 : 4,
    retries: 0,
    testRecoveriesAttempted: 1,
    testRecoveriesSucceeded: 1
  };
}

describe("benchmark reports", () => {
  it("enforces the accepted savings, quality, intervention, and safety thresholds", () => {
    const report = buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [
        observation("baseline", "task-a"),
        observation("shadow", "task-a"),
        observation("baseline", "task-b"),
        observation("shadow", "task-b")
      ]
    });

    expect(report.passed).toBe(true);
    expect(report.frontierTokenReduction).toBe(0.5);
    expect(report.qualityRetention).toBe(0.9);
    expect(report.medianInterventionDelta).toBe(1);
    expect(formatBenchmarkReport(report)).toContain("Benchmark fixture-suite-v1: PASS");
  });

  it("fails closed when task observations are not paired", () => {
    expect(() => buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [observation("baseline", "task-a"), observation("shadow", "task-b")]
    })).toThrow("exactly one paired");
  });

  it("treats an untested rejection requirement as vacuously met", () => {
    const withoutDangerousActions = (system: "baseline" | "shadow") => ({
      ...observation(system, "task-a"),
      dangerousActionsAttempted: 0,
      dangerousActionsRejected: 0
    });
    const report = buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [withoutDangerousActions("baseline"), withoutDangerousActions("shadow")]
    });

    expect(report.shadow.dangerousActionRejectionRate).toBe(1);
    expect(report.thresholds.dangerousActionRejection).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("carries unevaluated criteria through to the aggregate", () => {
    const report = buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [
        { ...observation("baseline", "task-a"), acceptanceCriteriaPassed: 8, unevaluatedCriteria: 2 },
        { ...observation("shadow", "task-a"), acceptanceCriteriaPassed: 8, unevaluatedCriteria: 2 }
      ]
    });

    expect(report.baseline.unevaluatedCriteria).toBe(2);
    expect(report.shadow.unevaluatedCriteria).toBe(2);
    expect(report.qualityRetention).toBe(1);
  });

  it("rejects an observation claiming more passed and unevaluated criteria than exist", () => {
    expect(() => buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [
        observation("baseline", "task-a"),
        { ...observation("shadow", "task-a"), acceptanceCriteriaPassed: 9, unevaluatedCriteria: 2 }
      ]
    })).toThrow();
  });

  it("does not count token savings when the safety threshold fails", () => {
    const unsafeShadow = {
      ...observation("shadow", "task-a"),
      dangerousActionsRejected: 0
    };
    const report = buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [observation("baseline", "task-a"), unsafeShadow]
    });

    expect(report.frontierTokenReduction).toBe(0.5);
    expect(report.thresholds.dangerousActionRejection).toBe(false);
    expect(report.passed).toBe(false);
  });
});
