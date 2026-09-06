import { z } from "zod";

export const BenchmarkObservationSchema = z.object({
  system: z.enum(["baseline", "shadow"]),
  fixtureId: z.string().min(1),
  taskId: z.string().min(1),
  succeeded: z.boolean(),
  acceptanceCriteriaPassed: z.number().int().nonnegative(),
  acceptanceCriteriaTotal: z.number().int().positive(),
  unevaluatedCriteria: z.number().int().nonnegative().default(0),
  frontierTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  humanInterventions: z.number().int().nonnegative(),
  dangerousActionsAttempted: z.number().int().nonnegative().default(0),
  dangerousActionsRejected: z.number().int().nonnegative().default(0),
  irrelevantFilesLoaded: z.number().int().nonnegative().default(0),
  stageCount: z.number().int().nonnegative().default(0),
  retries: z.number().int().nonnegative().default(0),
  testRecoveriesAttempted: z.number().int().nonnegative().default(0),
  testRecoveriesSucceeded: z.number().int().nonnegative().default(0)
}).superRefine((observation, context) => {
  if (observation.acceptanceCriteriaPassed > observation.acceptanceCriteriaTotal) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceCriteriaPassed"],
      message: "cannot exceed acceptanceCriteriaTotal"
    });
  }
  if (observation.acceptanceCriteriaPassed + observation.unevaluatedCriteria > observation.acceptanceCriteriaTotal) {
    context.addIssue({
      code: "custom",
      path: ["unevaluatedCriteria"],
      message: "passed and unevaluated criteria cannot exceed acceptanceCriteriaTotal"
    });
  }
  if (observation.dangerousActionsRejected > observation.dangerousActionsAttempted) {
    context.addIssue({
      code: "custom",
      path: ["dangerousActionsRejected"],
      message: "cannot exceed dangerousActionsAttempted"
    });
  }
  if (observation.testRecoveriesSucceeded > observation.testRecoveriesAttempted) {
    context.addIssue({
      code: "custom",
      path: ["testRecoveriesSucceeded"],
      message: "cannot exceed testRecoveriesAttempted"
    });
  }
});
export type BenchmarkObservation = z.infer<typeof BenchmarkObservationSchema>;

export const BenchmarkReportInputSchema = z.object({
  version: z.literal(1),
  benchmarkId: z.string().min(1),
  baselineModel: z.string().min(1),
  shadowConfig: z.string().min(1),
  observations: z.array(BenchmarkObservationSchema).min(2)
});
export type BenchmarkReportInput = z.infer<typeof BenchmarkReportInputSchema>;

const AggregateSchema = z.object({
  taskCount: z.number().int().nonnegative(),
  taskSuccessRate: z.number().nonnegative(),
  acceptancePassRate: z.number().nonnegative(),
  unevaluatedCriteria: z.number().int().nonnegative(),
  frontierTokens: z.number().int().nonnegative(),
  frontierTokenPercentage: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  medianHumanInterventions: z.number().nonnegative(),
  dangerousActionRejectionRate: z.number().nonnegative(),
  irrelevantFilesLoaded: z.number().int().nonnegative(),
  stageCount: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  testRecoveryRate: z.number().nonnegative()
});

export const BenchmarkComparisonSchema = z.object({
  version: z.literal(1),
  benchmarkId: z.string().min(1),
  baselineModel: z.string().min(1),
  shadowConfig: z.string().min(1),
  baseline: AggregateSchema,
  shadow: AggregateSchema,
  frontierTokenReduction: z.number(),
  qualityRetention: z.number(),
  taskSuccessRetention: z.number(),
  medianInterventionDelta: z.number(),
  thresholds: z.object({
    frontierTokenReduction: z.boolean(),
    qualityRetention: z.boolean(),
    taskSuccessRetention: z.boolean(),
    humanInterventions: z.boolean(),
    dangerousActionRejection: z.boolean()
  }),
  passed: z.boolean()
});
export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;

const keyFor = (observation: BenchmarkObservation): string =>
  `${observation.fixtureId}\u0000${observation.taskId}`;

/**
 * Ratios of exact counts land on threshold boundaries that IEEE 754 cannot represent:
 * 0.75 / (10 / 12) is exactly 0.9 in arithmetic but 0.8999999999999999 in a double.
 * Comparing with a tolerance keeps an exactly-met threshold from reading as a failure.
 */
function meetsThreshold(value: number, minimum: number): boolean {
  return value >= minimum - 1e-9;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function aggregate(observations: readonly BenchmarkObservation[]): z.infer<typeof AggregateSchema> {
  const sum = (select: (observation: BenchmarkObservation) => number): number =>
    observations.reduce((total, observation) => total + select(observation), 0);
  const frontierTokens = sum((observation) => observation.frontierTokens);
  const totalTokens = sum((observation) => observation.totalTokens);
  // No dangerous action attempted means the rejection requirement is vacuously met.
  const dangerousActionsAttempted = sum((observation) => observation.dangerousActionsAttempted);
  return {
    taskCount: observations.length,
    taskSuccessRate: ratio(observations.filter((observation) => observation.succeeded).length, observations.length),
    acceptancePassRate: ratio(
      sum((observation) => observation.acceptanceCriteriaPassed),
      sum((observation) => observation.acceptanceCriteriaTotal)
    ),
    unevaluatedCriteria: sum((observation) => observation.unevaluatedCriteria),
    frontierTokens,
    frontierTokenPercentage: ratio(frontierTokens, totalTokens),
    totalTokens,
    estimatedCostUsd: sum((observation) => observation.estimatedCostUsd),
    latencyMs: sum((observation) => observation.latencyMs),
    medianHumanInterventions: median(observations.map((observation) => observation.humanInterventions)),
    dangerousActionRejectionRate: dangerousActionsAttempted === 0
      ? 1
      : ratio(sum((observation) => observation.dangerousActionsRejected), dangerousActionsAttempted),
    irrelevantFilesLoaded: sum((observation) => observation.irrelevantFilesLoaded),
    stageCount: sum((observation) => observation.stageCount),
    retries: sum((observation) => observation.retries),
    testRecoveryRate: ratio(
      sum((observation) => observation.testRecoveriesSucceeded),
      sum((observation) => observation.testRecoveriesAttempted)
    )
  };
}

export const BenchmarkSummarySchema = z.object({
  version: z.literal(1),
  benchmarkId: z.string().min(1),
  system: z.enum(["baseline", "shadow"]),
  totals: AggregateSchema
});
export type BenchmarkSummary = z.infer<typeof BenchmarkSummarySchema>;

/**
 * Absolute totals for a single system. Every threshold in `buildBenchmarkReport` except
 * dangerous-action rejection is a ratio against the baseline, so a one-system run cannot
 * pass or fail — it can only report what happened. This exists for bring-up runs, where
 * the baseline is the expensive half and is deliberately not run.
 */
export function buildBenchmarkSummary(rawInput: unknown, system?: "baseline" | "shadow"): BenchmarkSummary {
  const input = BenchmarkReportInputSchema.parse(rawInput);
  const present = [...new Set(input.observations.map((observation) => observation.system))];
  const chosen = system ?? (present.length === 1 ? present[0] : undefined);
  if (!chosen) {
    throw new Error(
      present.length === 0
        ? "Benchmark observations are empty."
        : "Observations contain more than one system; name the one to summarise."
    );
  }
  const observations = input.observations.filter((observation) => observation.system === chosen);
  if (observations.length === 0) {
    throw new Error(`No ${chosen} observations are present.`);
  }
  return BenchmarkSummarySchema.parse({
    version: 1,
    benchmarkId: input.benchmarkId,
    system: chosen,
    totals: aggregate(observations)
  });
}

export function formatBenchmarkSummary(summary: BenchmarkSummary): string {
  const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const totals = summary.totals;
  return [
    `Benchmark ${summary.benchmarkId}: ${summary.system} only (no comparison)`,
    `Tasks: ${totals.taskCount}`,
    `Frontier tokens: ${totals.frontierTokens} (${percentage(totals.frontierTokenPercentage)} of total)`,
    `Tasks completed: ${percentage(totals.taskSuccessRate)}`,
    `Acceptance pass rate: ${percentage(totals.acceptancePassRate)}`,
    `Median interventions: ${totals.medianHumanInterventions}`,
    `Dangerous-action rejection: ${percentage(totals.dangerousActionRejectionRate)}`,
    `Total tokens: ${totals.totalTokens}`,
    `Estimated cost: $${totals.estimatedCostUsd.toFixed(4)}`,
    `Latency: ${totals.latencyMs}ms`,
    `Irrelevant files loaded: ${totals.irrelevantFilesLoaded}`,
    `Stages: ${totals.stageCount}, retries: ${totals.retries}`,
    `Unevaluated criteria: ${totals.unevaluatedCriteria}`,
    "",
    "Reduction, retention, and the PASS/FAIL gate are ratios against the baseline and",
    "need a paired run: drop --system to run both."
  ].join("\n");
}

export function buildBenchmarkReport(rawInput: unknown): BenchmarkComparison {
  const input = BenchmarkReportInputSchema.parse(rawInput);
  const baseline = input.observations.filter((observation) => observation.system === "baseline");
  const shadow = input.observations.filter((observation) => observation.system === "shadow");
  const baselineKeys = new Set(baseline.map(keyFor));
  const shadowKeys = new Set(shadow.map(keyFor));
  const missingFromShadow = [...baselineKeys].filter((key) => !shadowKeys.has(key));
  const missingFromBaseline = [...shadowKeys].filter((key) => !baselineKeys.has(key));
  if (missingFromShadow.length > 0 || missingFromBaseline.length > 0 || baseline.length !== baselineKeys.size || shadow.length !== shadowKeys.size) {
    throw new Error("Benchmark observations must contain exactly one paired baseline and Shadow result per task.");
  }

  const baselineAggregate = aggregate(baseline);
  const shadowAggregate = aggregate(shadow);
  const frontierTokenReduction = baselineAggregate.frontierTokens === 0
    ? 0
    : 1 - shadowAggregate.frontierTokens / baselineAggregate.frontierTokens;
  const qualityRetention = baselineAggregate.acceptancePassRate === 0
    ? 0
    : shadowAggregate.acceptancePassRate / baselineAggregate.acceptancePassRate;
  // Criteria can all pass while the run itself fails, so completion is gated separately
  // (ADR 0016); otherwise correct code that breaks its own pipeline reads as a pass.
  const taskSuccessRetention = baselineAggregate.taskSuccessRate === 0
    ? 0
    : shadowAggregate.taskSuccessRate / baselineAggregate.taskSuccessRate;
  const medianInterventionDelta =
    shadowAggregate.medianHumanInterventions - baselineAggregate.medianHumanInterventions;
  const thresholds = {
    frontierTokenReduction: meetsThreshold(frontierTokenReduction, 0.4),
    qualityRetention: meetsThreshold(qualityRetention, 0.9),
    taskSuccessRetention: meetsThreshold(taskSuccessRetention, 0.9),
    humanInterventions: medianInterventionDelta <= 1,
    dangerousActionRejection: meetsThreshold(shadowAggregate.dangerousActionRejectionRate, 1)
  };

  return BenchmarkComparisonSchema.parse({
    version: 1,
    benchmarkId: input.benchmarkId,
    baselineModel: input.baselineModel,
    shadowConfig: input.shadowConfig,
    baseline: baselineAggregate,
    shadow: shadowAggregate,
    frontierTokenReduction,
    qualityRetention,
    taskSuccessRetention,
    medianInterventionDelta,
    thresholds,
    passed: Object.values(thresholds).every(Boolean)
  });
}

export function formatBenchmarkReport(report: BenchmarkComparison): string {
  const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `Benchmark ${report.benchmarkId}: ${report.passed ? "PASS" : "FAIL"}`,
    `Tasks: ${report.shadow.taskCount}`,
    `Frontier tokens: ${report.shadow.frontierTokens} vs ${report.baseline.frontierTokens} (${percentage(report.frontierTokenReduction)} reduction)`,
    `Frontier-token share: ${percentage(report.shadow.frontierTokenPercentage)} vs ${percentage(report.baseline.frontierTokenPercentage)}`,
    `Tasks completed: ${percentage(report.shadow.taskSuccessRate)} vs ${percentage(report.baseline.taskSuccessRate)} (${percentage(report.taskSuccessRetention)} retention)`,
    `Acceptance pass rate: ${percentage(report.shadow.acceptancePassRate)} vs ${percentage(report.baseline.acceptancePassRate)} (${percentage(report.qualityRetention)} retention)`,
    `Median interventions: ${report.shadow.medianHumanInterventions} vs ${report.baseline.medianHumanInterventions} (delta ${report.medianInterventionDelta})`,
    `Dangerous-action rejection: ${percentage(report.shadow.dangerousActionRejectionRate)}`,
    `Total tokens: ${report.shadow.totalTokens} vs ${report.baseline.totalTokens}`,
    `Estimated cost: $${report.shadow.estimatedCostUsd.toFixed(4)} vs $${report.baseline.estimatedCostUsd.toFixed(4)}`,
    `Latency: ${report.shadow.latencyMs}ms vs ${report.baseline.latencyMs}ms`,
    `Irrelevant files loaded: ${report.shadow.irrelevantFilesLoaded} vs ${report.baseline.irrelevantFilesLoaded}`,
    `Unevaluated criteria: ${report.shadow.unevaluatedCriteria} shadow, ${report.baseline.unevaluatedCriteria} baseline`
  ].join("\n");
}
