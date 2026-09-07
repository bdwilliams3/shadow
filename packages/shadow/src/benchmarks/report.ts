import { z } from "zod";
import { ArtifactReferenceSchema, ModelAliasSchema, UsageTotalsSchema, type ModelAlias } from "../orchestration/types.js";

const ModelUsageSchema = UsageTotalsSchema.extend({
  provider: z.string().min(1),
  model: z.string().min(1),
  modelAlias: ModelAliasSchema.optional(),
  totalTokens: z.number().int().nonnegative()
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

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
  modelUsage: z.array(ModelUsageSchema).default([]),
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

export const BenchmarkWorkspaceSchema = z.object({
  fixtureId: z.string().min(1),
  taskId: z.string().min(1),
  system: z.enum(["baseline", "shadow"]),
  workspaceRoot: z.string().min(1),
  status: z.string().min(1),
  summary: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  failedChecks: z.array(z.object({
    id: z.string().min(1),
    detail: z.string()
  })).default([]),
  artifacts: z.array(ArtifactReferenceSchema).default([])
});
export type BenchmarkWorkspace = z.infer<typeof BenchmarkWorkspaceSchema>;

export const BenchmarkReportInputSchema = z.object({
  version: z.literal(1),
  benchmarkId: z.string().min(1),
  baselineModel: z.string().min(1),
  shadowConfig: z.string().min(1),
  /**
   * Where fixture workspaces were provisioned. Benchmark workspaces are intentionally kept
   * for inspection; saving this path in the JSON makes failed-run artifacts findable after
   * the terminal output is gone.
   */
  workRoot: z.string().min(1).optional(),
  /**
   * Per-task audit breadcrumbs. Reports still aggregate from observations, but a failed
   * result needs enough metadata to locate `develop.patch`, `patch.check` output, and the
   * exact workspace without spelunking through transient logs.
   */
  workspaces: z.array(BenchmarkWorkspaceSchema).default([]),
  /**
   * What each capability tier resolved to when an older run was taken. Optional so runs
   * recorded before this field still parse. Tiers deliberately collapsed onto one model
   * make every cost figure and every ratio between tiers synthetic, and this is what lets
   * the output say so instead of leaving a future reader to quote fiction.
   */
  tierModels: z.record(ModelAliasSchema, z.string().min(1)).optional(),
  /**
   * What each direct model alias resolved to when this run was taken.
   */
  modelAliases: z.record(ModelAliasSchema, z.string().min(1)).optional(),
  /**
   * Fixture id to repository revision, as provisioned for this run. Optional so earlier
   * results still parse. Committing the fixture corpus is what makes a saved number
   * reproducible, and that only works if the number says which revision it came from.
   */
  fixtureRevisions: z.record(z.string(), z.string().min(1)).optional(),
  observations: z.array(BenchmarkObservationSchema).min(1)
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
  modelUsage: z.array(ModelUsageSchema).default([]),
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
  tierModels: z.record(ModelAliasSchema, z.string().min(1)).optional(),
  modelAliases: z.record(ModelAliasSchema, z.string().min(1)).optional(),
  fixtureRevisions: z.record(z.string(), z.string().min(1)).optional(),
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
    modelUsage: aggregateModelUsage(observations.flatMap((observation) => observation.modelUsage)),
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

function aggregateModelUsage(usages: readonly ModelUsage[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const usage of usages) {
    const key = `${usage.provider}\u0000${usage.model}\u0000${usage.modelAlias ?? ""}`;
    const existing = byModel.get(key);
    if (!existing) {
      byModel.set(key, { ...usage });
      continue;
    }
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
    existing.totalTokens += usage.totalTokens;
    existing.estimatedCostUsd += usage.estimatedCostUsd;
  }
  return [...byModel.values()].sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)
  );
}

export const BenchmarkSummarySchema = z.object({
  version: z.literal(1),
  benchmarkId: z.string().min(1),
  system: z.enum(["baseline", "shadow"]),
  tierModels: z.record(ModelAliasSchema, z.string().min(1)).optional(),
  modelAliases: z.record(ModelAliasSchema, z.string().min(1)).optional(),
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
    ...(input.tierModels ? { tierModels: input.tierModels } : {}),
    ...(input.modelAliases ? { modelAliases: input.modelAliases } : {}),
    totals: aggregate(observations)
  });
}

/**
 * The tier table a run was taken under, as one line. Always shown when recorded: which
 * model each tier resolved to is provenance for the numbers, and the table is a knob
 * users are expected to turn — swapping models per tier is the point of it, not a
 * condition to flag.
 */
export function formatFixtureRevisions(
  revisions: Record<string, string> | undefined
): string | undefined {
  if (!revisions) return undefined;
  const entries = Object.entries(revisions).map(([id, revision]) => `${id}@${revision}`);
  return entries.length > 0 ? `Fixtures: ${entries.join(", ")}` : undefined;
}

export function formatTierModels(
  tierModels: Partial<Record<ModelAlias, string>> | undefined
): string | undefined {
  if (!tierModels) return undefined;
  const entries = Object.entries(tierModels).map(([tier, model]) => `${tier}=${model}`);
  return entries.length > 0 ? `Tiers: ${entries.join(", ")}` : undefined;
}

export function formatModelAliases(
  modelAliases: Partial<Record<ModelAlias, string>> | undefined
): string | undefined {
  if (!modelAliases) return undefined;
  const entries = Object.entries(modelAliases).map(([alias, model]) => `${alias}=${model}`);
  return entries.length > 0 ? `Models: ${entries.join(", ")}` : undefined;
}

export function formatBenchmarkSummary(summary: BenchmarkSummary): string {
  const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const totals = summary.totals;
  const tiers = formatTierModels(summary.tierModels);
  const models = formatModelAliases(summary.modelAliases);
  return [
    ...(models ? [models] : []),
    ...(tiers ? [tiers] : []),
    `Benchmark ${summary.benchmarkId}: ${summary.system} only (no comparison)`,
    `Tasks: ${totals.taskCount}`,
    `Reserved/baseline-model tokens: ${totals.frontierTokens} (${percentage(totals.frontierTokenPercentage)} of total)`,
    `Tasks completed: ${percentage(totals.taskSuccessRate)}`,
    `Acceptance pass rate: ${percentage(totals.acceptancePassRate)}`,
    `Median interventions: ${totals.medianHumanInterventions}`,
    `Dangerous-action rejection: ${percentage(totals.dangerousActionRejectionRate)}`,
    `Total tokens: ${totals.totalTokens}`,
    `Estimated cost: $${totals.estimatedCostUsd.toFixed(4)}`,
    ...formatModelUsageLines(summary.system, totals.modelUsage, totals.totalTokens, totals.estimatedCostUsd),
    `Latency: ${totals.latencyMs}ms`,
    `Irrelevant files loaded: ${totals.irrelevantFilesLoaded}`,
    `Stages: ${totals.stageCount}, retries: ${totals.retries}`,
    `Unevaluated criteria: ${totals.unevaluatedCriteria}`,
    "",
    "Reduction, retention, and the PASS/FAIL gate are ratios against the baseline and",
    "need a paired run: drop --system to run both."
  ].join("\n");
}

function formatModelUsageLines(
  system: string,
  usages: readonly ModelUsage[],
  totalTokens: number,
  estimatedCostUsd: number
): string[] {
  if (usages.length === 0) {
    return totalTokens > 0 || estimatedCostUsd > 0
      ? [`Model usage (${system}): unavailable in this result file`]
      : [];
  }
  return [
    `Model usage (${system}): ${usages
      .map((usage) =>
        `${usage.provider}/${usage.model}` +
        `${usage.modelAlias ? ` as ${usage.modelAlias}` : ""}: ` +
        `${usage.totalTokens} tok, $${usage.estimatedCostUsd.toFixed(4)}`
      )
      .join("; ")}`
  ];
}

/**
 * How much of the baseline's result Shadow kept.
 *
 * A zero baseline used to report zero retention, which inverted the meaning: on the sspm
 * fixture the baseline passed no criteria and Shadow passed all of them, and the gate
 * failed Shadow for it. A baseline that achieved nothing cannot have been regressed
 * against, so beating it scores 1. Both scoring zero is not a pass either — nothing was
 * demonstrated — so that stays 0 and the gate still fails.
 */
function retention(shadow: number, baseline: number): number {
  if (baseline > 0) return shadow / baseline;
  return shadow > 0 ? 1 : 0;
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
  const qualityRetention = retention(
    shadowAggregate.acceptancePassRate,
    baselineAggregate.acceptancePassRate
  );
  // Criteria can all pass while the run itself fails, so completion is gated separately
  // (ADR 0016); otherwise correct code that breaks its own pipeline reads as a pass.
  const taskSuccessRetention = retention(
    shadowAggregate.taskSuccessRate,
    baselineAggregate.taskSuccessRate
  );
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
    ...(input.tierModels ? { tierModels: input.tierModels } : {}),
    ...(input.modelAliases ? { modelAliases: input.modelAliases } : {}),
    ...(input.fixtureRevisions ? { fixtureRevisions: input.fixtureRevisions } : {}),
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
  const tiers = formatTierModels(report.tierModels);
  const models = formatModelAliases(report.modelAliases);
  const fixtures = formatFixtureRevisions(report.fixtureRevisions);
  return [
    ...(fixtures ? [fixtures] : []),
    ...(models ? [models] : []),
    ...(tiers ? [tiers] : []),
    `Benchmark ${report.benchmarkId}: ${report.passed ? "PASS" : "FAIL"}`,
    `Tasks: ${report.shadow.taskCount}`,
    `Reserved/baseline-model tokens: ${report.shadow.frontierTokens} vs ${report.baseline.frontierTokens} (${percentage(report.frontierTokenReduction)} reduction)`,
    `Reserved/baseline-model share: ${percentage(report.shadow.frontierTokenPercentage)} vs ${percentage(report.baseline.frontierTokenPercentage)}`,
    `Tasks completed: ${percentage(report.shadow.taskSuccessRate)} vs ${percentage(report.baseline.taskSuccessRate)} (${percentage(report.taskSuccessRetention)} retention)`,
    `Acceptance pass rate: ${percentage(report.shadow.acceptancePassRate)} vs ${percentage(report.baseline.acceptancePassRate)} (${percentage(report.qualityRetention)} retention)`,
    `Median interventions: ${report.shadow.medianHumanInterventions} vs ${report.baseline.medianHumanInterventions} (delta ${report.medianInterventionDelta})`,
    `Dangerous-action rejection: ${percentage(report.shadow.dangerousActionRejectionRate)}`,
    `Total tokens: ${report.shadow.totalTokens} vs ${report.baseline.totalTokens}`,
    `Estimated cost: $${report.shadow.estimatedCostUsd.toFixed(4)} vs $${report.baseline.estimatedCostUsd.toFixed(4)}`,
    ...formatModelUsageLines(
      "shadow",
      report.shadow.modelUsage,
      report.shadow.totalTokens,
      report.shadow.estimatedCostUsd
    ),
    ...formatModelUsageLines(
      "baseline",
      report.baseline.modelUsage,
      report.baseline.totalTokens,
      report.baseline.estimatedCostUsd
    ),
    `Latency: ${report.shadow.latencyMs}ms vs ${report.baseline.latencyMs}ms`,
    `Irrelevant files loaded: ${report.shadow.irrelevantFilesLoaded} vs ${report.baseline.irrelevantFilesLoaded}`,
    `Unevaluated criteria: ${report.shadow.unevaluatedCriteria} shadow, ${report.baseline.unevaluatedCriteria} baseline`
  ].join("\n");
}
