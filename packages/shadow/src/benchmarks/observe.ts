import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ModelCallRecord, Run } from "../orchestration/types.js";
import { SelectedContextSchema } from "../tools/actions/context.js";
import { BenchmarkObservationSchema, type BenchmarkObservation } from "./report.js";

export const ShadowObservationOptionsSchema = z.object({
  fixtureId: z.string().min(1),
  taskId: z.string().min(1),
  acceptanceCriteriaPassed: z.number().int().nonnegative(),
  acceptanceCriteriaTotal: z.number().int().positive(),
  unevaluatedCriteria: z.number().int().nonnegative().default(0),
  relevantFiles: z.array(z.string().min(1)).default([]),
  dangerousOperations: z.array(z.string().min(1)).default([]),
  baselineModel: z.string().min(1).optional()
}).superRefine((options, context) => {
  if (options.acceptanceCriteriaPassed > options.acceptanceCriteriaTotal) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceCriteriaPassed"],
      message: "cannot exceed acceptanceCriteriaTotal"
    });
  }
});
export type ShadowObservationOptions = z.infer<typeof ShadowObservationOptionsSchema>;

export async function buildShadowObservation(
  run: Run,
  rawOptions: unknown,
  artifacts: ArtifactStore
): Promise<BenchmarkObservation> {
  if (run.state !== "COMPLETED" && run.state !== "FAILED" && run.state !== "CANCELLED") {
    throw new Error(`Run ${run.id} is not terminal and cannot produce a benchmark observation.`);
  }
  const options = ShadowObservationOptionsSchema.parse(rawOptions);
  const attempts = run.stageRuns.flatMap((stage) => stage.attemptResults);
  const modelCalls = attempts.flatMap((attempt) => attempt.modelCalls);
  const frontierTokens = modelCalls
    .filter((call) =>
      call.frontier ||
      call.tier === "frontier" ||
      (options.baselineModel !== undefined && `${call.provider}/${call.model}` === options.baselineModel)
    )
    .reduce((total, call) => total + call.usage.inputTokens + call.usage.outputTokens, 0);
  const relevantFiles = new Set(options.relevantFiles.map(normalizePath));
  // Distinct paths, not a per-attempt sum: a retried stage re-selects the same files,
  // and counting them again made retries look like worse context selection.
  const irrelevantPaths = new Set<string>();
  for (const attempt of attempts) {
    for (const call of attempt.toolCalls.filter((candidate) => candidate.actionId === "context.select")) {
      const resultArtifact = call.artifacts.find((artifact) => artifact.kind === "action.result");
      if (!resultArtifact) continue;
      const selected = SelectedContextSchema.parse(
        JSON.parse(await artifacts.readText(resultArtifact, 2_000_000))
      );
      for (const file of selected.files) {
        if (!relevantFiles.has(normalizePath(file.path))) {
          irrelevantPaths.add(normalizePath(file.path));
        }
      }
    }
  }
  const dangerousOperations = new Set(options.dangerousOperations);
  const dangerousApprovals = run.approvals.filter((approval) =>
    dangerousOperations.has(approval.operation)
  );
  const testStages = run.stageRuns.filter((stage) => stage.stage === "test");
  const recoveryAttempts = testStages.filter((stage) =>
    stage.attemptResults.some((attempt) => attempt.status === "failed")
  );
  const createdAt = Date.parse(run.createdAt);
  const updatedAt = Date.parse(run.updatedAt);

  return BenchmarkObservationSchema.parse({
    system: "shadow",
    fixtureId: options.fixtureId,
    taskId: options.taskId,
    succeeded: run.state === "COMPLETED" &&
      options.acceptanceCriteriaPassed === options.acceptanceCriteriaTotal,
    acceptanceCriteriaPassed: options.acceptanceCriteriaPassed,
    acceptanceCriteriaTotal: options.acceptanceCriteriaTotal,
    unevaluatedCriteria: options.unevaluatedCriteria,
    frontierTokens,
    totalTokens: run.usage.inputTokens + run.usage.outputTokens,
    estimatedCostUsd: run.usage.estimatedCostUsd,
    modelUsage: modelUsageFromCalls(modelCalls),
    latencyMs: Number.isFinite(createdAt) && Number.isFinite(updatedAt)
      ? Math.max(0, Math.round(updatedAt - createdAt))
      : 0,
    humanInterventions: run.approvals.filter((approval) => approval.status !== "pending").length,
    dangerousActionsAttempted: dangerousApprovals.length,
    dangerousActionsRejected: dangerousApprovals.filter((approval) => approval.status === "rejected").length,
    irrelevantFilesLoaded: irrelevantPaths.size,
    stageCount: run.stageRuns.filter((stage) => stage.attempts > 0).length,
    retries: run.stageRuns.reduce((total, stage) => total + Math.max(0, stage.attempts - 1), 0),
    testRecoveriesAttempted: recoveryAttempts.length,
    testRecoveriesSucceeded: recoveryAttempts.filter((stage) =>
      stage.attemptResults.some((attempt) => attempt.status === "completed")
    ).length
  });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function modelUsageFromCalls(modelCalls: readonly ModelCallRecord[]) {
  return modelCalls.map((call) => ({
    provider: call.provider,
    model: call.model,
    ...(call.modelAlias ? { modelAlias: call.modelAlias } : {}),
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    totalTokens: call.usage.inputTokens + call.usage.outputTokens,
    estimatedCostUsd: call.usage.estimatedCostUsd
  }));
}
