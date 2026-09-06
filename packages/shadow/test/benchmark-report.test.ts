import { describe, expect, it } from "vitest";
import {
  buildBenchmarkReport,
  buildBenchmarkSummary,
  formatTierModels,
  formatBenchmarkReport,
  formatBenchmarkSummary
} from "../src/benchmarks/report.js";

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

  it("passes a threshold that is met exactly despite float representation", () => {
    // The real 2026-09-05 run: baseline 10/12 criteria, shadow 9/12. Retention is
    // exactly 0.9, but 0.75 / (10 / 12) evaluates to 0.8999999999999999.
    const report = buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [
        {
          ...observation("baseline", "task-a"),
          acceptanceCriteriaPassed: 10,
          acceptanceCriteriaTotal: 12,
          frontierTokens: 10_000
        },
        {
          ...observation("shadow", "task-a"),
          acceptanceCriteriaPassed: 9,
          acceptanceCriteriaTotal: 12,
          frontierTokens: 0
        }
      ]
    });

    expect(report.qualityRetention).toBeLessThan(0.9);
    expect(report.thresholds.qualityRetention).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("fails when Shadow completes fewer tasks even though its criteria pass", () => {
    // Run 2, 2026-09-05: Shadow matched the baseline on criteria (11/12 each) but
    // completed 2 of 5 tasks to the baseline's 3. The old report called that PASS.
    const shadowIncomplete = { ...observation("shadow", "task-b"), succeeded: false };
    const report = buildBenchmarkReport({
      version: 1,
      benchmarkId: "fixture-suite-v1",
      baselineModel: "provider/frontier",
      shadowConfig: "config-v1",
      observations: [
        observation("baseline", "task-a"),
        observation("shadow", "task-a"),
        observation("baseline", "task-b"),
        shadowIncomplete
      ]
    });

    expect(report.thresholds.qualityRetention).toBe(true);
    expect(report.taskSuccessRetention).toBe(0.5);
    expect(report.thresholds.taskSuccessRetention).toBe(false);
    expect(report.passed).toBe(false);
    expect(formatBenchmarkReport(report)).toContain("Tasks completed: 50.0% vs 100.0%");
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

describe("single-system summary", () => {
  it("reports totals for a shadow-only run instead of demanding a baseline", () => {
    const input = {
      version: 1,
      benchmarkId: "bring-up",
      baselineModel: "provider/model",
      shadowConfig: "plan=economy",
      observations: [observation("shadow", "task-a"), observation("shadow", "task-b")]
    };

    expect(() => buildBenchmarkReport(input)).toThrow();

    const summary = buildBenchmarkSummary(input);
    expect(summary.system).toBe("shadow");
    expect(summary.totals.taskCount).toBe(2);

    const text = formatBenchmarkSummary(summary);
    expect(text).toContain("shadow only (no comparison)");
    // No verdict and no ratio: there is nothing to compare against. The closing note
    // naming the missing gate is allowed, and is the point.
    expect(text).not.toMatch(/^Benchmark .*: (PASS|FAIL)$/m);
    expect(text).not.toMatch(/% reduction/);
    expect(text).not.toMatch(/retention\)/);
    expect(text).toContain("drop --system to run both");
  });

  it("refuses to guess when both systems are present", () => {
    const input = {
      version: 1,
      benchmarkId: "paired",
      baselineModel: "provider/model",
      shadowConfig: "plan=economy",
      observations: [observation("shadow", "task-a"), observation("baseline", "task-a")]
    };
    expect(() => buildBenchmarkSummary(input)).toThrow(/more than one system/);
    expect(buildBenchmarkSummary(input, "baseline").system).toBe("baseline");
  });
});

describe("tier provenance", () => {
  it("reports which model each tier resolved to, however they are configured", () => {
    const input = {
      version: 1,
      benchmarkId: "toggled",
      baselineModel: "default/gpt-5.4-mini",
      shadowConfig: "plan=frontier",
      tierModels: {
        frontier: "default/sonnet",
        balanced: "default/gpt-5.4-mini",
        economy: "default/gpt-5.4-mini"
      },
      observations: [observation("shadow", "task-a"), observation("baseline", "task-a")]
    };

    // Two tiers sharing a model is an ordinary configuration, not a condition to flag.
    const report = formatBenchmarkReport(buildBenchmarkReport(input));
    expect(report).toContain("Tiers: frontier=default/sonnet");
    expect(report).toContain("economy=default/gpt-5.4-mini");
    expect(report).not.toContain("WARNING");

    expect(formatBenchmarkSummary(buildBenchmarkSummary(input, "shadow")))
      .toContain("Tiers: frontier=default/sonnet");
  });

  it("says nothing for runs recorded before tier models were captured", () => {
    expect(formatTierModels(undefined)).toBeUndefined();
  });
});
