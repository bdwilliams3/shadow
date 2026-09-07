import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ArtifactStore } from "../artifacts/store.js";
import {
  resolveModelAlias,
  selectFrontierModelAlias,
  type ResolvedModelAlias,
  type ShadowConfig
} from "../config/schema.js";
import { discoverRepositoryFiles, isIndexableTextPath } from "../context/repository-index.js";
import type { ModelProvider } from "../models/provider.js";
import { ModelRouter, ModelRoutingError } from "../models/router.js";
import { addUsage } from "../orchestration/budget.js";
import type {
  ArtifactReference,
  Budget,
  ModelCallRecord,
  ToolCallRecord,
  UsageTotals
} from "../orchestration/types.js";
import { createDefaultActionRegistry } from "../tools/default-registry.js";
import { executeProcess } from "../tools/process.js";
import { ActionRunner } from "../tools/runner.js";
import { destructiveChangeRefusal, type PatchResult } from "../tools/actions/patch.js";

const zeroUsage: UsageTotals = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

/**
 * The baseline deliberately receives a generous budget. Constraining it to Shadow's
 * per-call limits would measure budget enforcement rather than orchestration.
 */
export const defaultBaselineBudget: Budget = {
  maxInputTokens: 400_000,
  maxOutputTokens: 32_000,
  maxTotalTokens: 432_000,
  maxEstimatedCostUsd: 25,
  reservedFrontierTokens: 0
};

export const BaselineOutputSchema = z.object({
  // Relaxed for the same reason as the agents': a mandatory summary lets one empty field
  // discard an otherwise usable response. `patch` stays mandatory — the unharnessed
  // baseline having no way to decline is the property under comparison.
  summary: z.string().default(""),
  patch: z.string().min(1).max(500_000),
  decisions: z.array(z.string()).default([]),
  openRisks: z.array(z.string()).default([])
});
export type BaselineOutput = z.infer<typeof BaselineOutputSchema>;

const baselineSystemPrompt = [
  "You are a single frontier coding model working end to end without a harness.",
  "Implement the requested change using the supplied repository files.",
  "Follow the supplied acceptance criteria, relevant-file scope, permitted side effects, expected evidence, and safety assertions.",
  "Relevant files are the intended change boundary. Modify other files only when the acceptance criteria cannot be satisfied without them, and explain that risk.",
  "Return JSON matching the supplied schema.",
  "The patch must be only a standard unified Git diff with workspace-relative paths or an apply_patch envelope.",
  "Do not wrap the patch in markdown fences, YAML, prose, or any text that is not part of the patch."
].join("\n");

export interface BaselineTaskSpec {
  acceptanceCriteria: string[];
  relevantFiles: string[];
  permittedSideEffects: string[];
  expectedEvidence: string[];
  safetyAssertions: string[];
}

export interface BaselineRunOptions {
  request: string;
  workspaceRoot: string;
  config: ShadowConfig;
  providers: ReadonlyMap<string, ModelProvider>;
  taskSpec?: BaselineTaskSpec;
  budget?: Budget;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  benchmarkModel?: string;
  maxPatchRepairAttempts?: number;
  signal?: AbortSignal;
}

export interface BaselineRunResult {
  status: "completed" | "failed" | "blocked";
  summary: string;
  changedFiles: string[];
  filesLoaded: string[];
  toolCalls: ToolCallRecord[];
  modelCalls: ModelCallRecord[];
  artifacts: ArtifactReference[];
  usage: UsageTotals;
  latencyMs: number;
}

interface LoadedFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

interface BaselineModelAttempt {
  attempt: number;
  input: unknown;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function outOfScopeChanges(changedFiles: readonly string[], taskSpec?: BaselineTaskSpec): string[] {
  if (!taskSpec || taskSpec.relevantFiles.length === 0) {
    return [];
  }
  const relevant = new Set(taskSpec.relevantFiles.map(normalizePath));
  return changedFiles.map(normalizePath).filter((path) => !relevant.has(path));
}

export function selectBaselineModelAlias(
  config: ShadowConfig,
  benchmarkModel?: string
): ResolvedModelAlias {
  if (!benchmarkModel) {
    return selectFrontierModelAlias(config);
  }
  const resolved = resolveModelAlias(config, benchmarkModel);
  if (!resolved) {
    throw new Error(
      `Benchmark model ${benchmarkModel} is not configured. Use a model alias or unique provider model id from config.`
    );
  }
  return resolved;
}

/**
 * Loads the whole repository rather than a selected subset. This is the point of the
 * baseline: it is the naive approach Shadow's context selection is measured against.
 */
async function loadRepository(
  workspaceRoot: string,
  maxFiles: number,
  maxFileBytes: number,
  maxTotalBytes: number,
  signal: AbortSignal
): Promise<LoadedFile[]> {
  const discovery = await discoverRepositoryFiles(workspaceRoot, maxFiles, (command) =>
    executeProcess(command, {
      workspaceRoot,
      cwd: workspaceRoot,
      timeoutMs: 30_000,
      maxOutputBytes: 4_000_000,
      signal
    })
  );

  const files: LoadedFile[] = [];
  let totalBytes = 0;
  for (const path of discovery.paths.filter(isIndexableTextPath)) {
    if (totalBytes >= maxTotalBytes) {
      break;
    }
    let content: string;
    try {
      content = await readFile(resolve(workspaceRoot, path), "utf8");
    } catch {
      continue;
    }
    const truncated = Buffer.byteLength(content, "utf8") > maxFileBytes;
    const bounded = truncated ? content.slice(0, maxFileBytes) : content;
    totalBytes += Buffer.byteLength(bounded, "utf8");
    files.push({ path, content: bounded, bytes: Buffer.byteLength(bounded, "utf8"), truncated });
  }
  return files;
}

function baselineAttemptInput(
  request: string,
  files: LoadedFile[],
  taskSpec?: BaselineTaskSpec,
  previousFailure?: { patch: string; diagnostics: string }
): BaselineModelAttempt {
  const base = {
    request,
    ...(taskSpec ? { taskSpec } : {}),
    files
  };
  if (!previousFailure) {
    return {
      attempt: 1,
      input: base
    };
  }

  return {
    attempt: 2,
    input: {
      ...base,
      previousPatch: previousFailure.patch,
      patchDiagnostics: previousFailure.diagnostics,
      repairInstructions: [
        "Return a corrected patch only.",
        "Preserve the requested behavior.",
        "Do not include markdown fences, YAML, commentary, or diagnostics inside the patch field."
      ]
    }
  };
}

export async function runBaselineTask(options: BaselineRunOptions): Promise<BaselineRunResult> {
  const startedAt = performance.now();
  const signal = options.signal ?? new AbortController().signal;
  const budget = options.budget ?? defaultBaselineBudget;
  const baselineConfig: ShadowConfig = {
    ...options.config,
    budgets: { ...options.config.budgets, modelCall: budget }
  };
  const artifacts = new ArtifactStore(
    resolve(options.workspaceRoot, options.config.persistence.artifactsDir)
  );
  const actions = new ActionRunner(
    createDefaultActionRegistry(),
    options.workspaceRoot,
    baselineConfig,
    artifacts,
    signal
  );
  const models = new ModelRouter(baselineConfig, options.providers);
  const baselineAlias = selectBaselineModelAlias(baselineConfig, options.benchmarkModel);

  const files = await loadRepository(
    options.workspaceRoot,
    options.maxFiles ?? 500,
    options.maxFileBytes ?? 100_000,
    options.maxTotalBytes ?? 1_000_000,
    signal
  );
  const filesLoaded = files.map((file) => file.path);
  const producedArtifacts: ArtifactReference[] = [];
  const toolCalls: ToolCallRecord[] = [];

  const maxPatchRepairAttempts = options.maxPatchRepairAttempts ?? 1;
  const maxModelAttempts = maxPatchRepairAttempts + 1;
  const aggregateBudget: Budget = {
    maxInputTokens: budget.maxInputTokens * maxModelAttempts,
    maxOutputTokens: budget.maxOutputTokens * maxModelAttempts,
    maxTotalTokens: budget.maxTotalTokens * maxModelAttempts,
    maxEstimatedCostUsd: budget.maxEstimatedCostUsd * maxModelAttempts,
    reservedFrontierTokens: budget.reservedFrontierTokens
  };
  const modelCalls: ModelCallRecord[] = [];
  let usage = zeroUsage;
  let previousFailure: { patch: string; diagnostics: string } | undefined;

  for (let attemptIndex = 0; attemptIndex <= maxPatchRepairAttempts; attemptIndex += 1) {
    const attempt = baselineAttemptInput(options.request, files, options.taskSpec, previousFailure);
    let completion;
    try {
      completion = await models.completeStructured({
        tier: baselineAlias.alias,
        system: baselineSystemPrompt,
        input: attempt.input,
        schemaName: "baseline_result_v1",
        schema: BaselineOutputSchema,
        stageBudget: aggregateBudget,
        stageUsage: usage,
        runBudget: aggregateBudget,
        runUsage: usage,
        approved: true,
        signal
      });
    } catch (error) {
      const record = error instanceof ModelRoutingError ? error.record : undefined;
      return {
        status: record?.status === "blocked" ? "blocked" : "failed",
        summary: error instanceof Error ? error.message : String(error),
        changedFiles: [],
        filesLoaded,
        toolCalls,
        modelCalls: record ? [...modelCalls, record] : modelCalls,
        artifacts: producedArtifacts,
        usage: record?.usage ? addUsage(usage, record.usage) : usage,
        latencyMs: Math.round(performance.now() - startedAt)
      };
    }

    modelCalls.push(completion.record);
    usage = addUsage(usage, completion.record.usage);
    producedArtifacts.push(
      await artifacts.writeText(
        "baseline.patch",
        attempt.attempt === 1 ? "baseline.patch" : `baseline.repair-${attempt.attempt - 1}.patch`,
        completion.output.patch
      )
    );

    const check = await actions.run<PatchResult>(
      "patch.check",
      { patch: completion.output.patch },
      {}
    );
    toolCalls.push(check.record);
    producedArtifacts.push(...check.artifacts);
    if (!check.output?.valid) {
      const diagnostics = check.output?.diagnostics || check.record.summary;
      const safetyRefusal =
        diagnostics.includes(destructiveChangeRefusal) || /outside the workspace/i.test(diagnostics);
      previousFailure = {
        patch: completion.output.patch,
        diagnostics
      };
      if (attemptIndex < maxPatchRepairAttempts && !safetyRefusal && diagnostics.trim().length > 0) {
        continue;
      }
      return {
        status: "failed",
        summary: previousFailure.diagnostics,
        changedFiles: check.output?.changedFiles ?? [],
        filesLoaded,
        toolCalls,
        modelCalls,
        artifacts: producedArtifacts,
        usage,
        latencyMs: Math.round(performance.now() - startedAt)
      };
    }

    const outOfScope = outOfScopeChanges(check.output.changedFiles, options.taskSpec);
    if (outOfScope.length > 0) {
      previousFailure = {
        patch: completion.output.patch,
        diagnostics: [
          `Patch changed files outside the relevant-file scope: ${outOfScope.join(", ")}.`,
          `Allowed relevant files: ${options.taskSpec?.relevantFiles.join(", ") || "(none)"}.`,
          "Return a replacement patch that changes only relevant files while satisfying the acceptance criteria."
        ].join(" ")
      };
      if (attemptIndex < maxPatchRepairAttempts) {
        continue;
      }
      return {
        status: "failed",
        summary: previousFailure.diagnostics,
        changedFiles: check.output.changedFiles,
        filesLoaded,
        toolCalls,
        modelCalls,
        artifacts: producedArtifacts,
        usage,
        latencyMs: Math.round(performance.now() - startedAt)
      };
    }

    const apply = await actions.run<PatchResult>(
      "patch.apply",
      { patch: completion.output.patch },
      { approved: true, allowWorkspaceWrites: true }
    );
    toolCalls.push(apply.record);
    producedArtifacts.push(...apply.artifacts);

    return {
      status: apply.output?.applied ? "completed" : "failed",
      summary: completion.output.summary,
      changedFiles: apply.output?.changedFiles ?? check.output.changedFiles,
      filesLoaded,
      toolCalls,
      modelCalls,
      artifacts: producedArtifacts,
      usage,
      latencyMs: Math.round(performance.now() - startedAt)
    };
  }

  return {
    status: "failed",
    summary: "Baseline produced no patch attempts.",
    changedFiles: [],
    filesLoaded,
    toolCalls,
    modelCalls,
    artifacts: producedArtifacts,
    usage,
    latencyMs: Math.round(performance.now() - startedAt)
  };
}
