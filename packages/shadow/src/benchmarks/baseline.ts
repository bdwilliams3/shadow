import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ArtifactStore } from "../artifacts/store.js";
import type { ShadowConfig } from "../config/schema.js";
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
import type { PatchResult } from "../tools/actions/patch.js";

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
  "Return JSON matching the supplied schema.",
  "The patch must be a standard unified Git diff with workspace-relative paths."
].join("\n");

export interface BaselineRunOptions {
  request: string;
  workspaceRoot: string;
  config: ShadowConfig;
  providers: ReadonlyMap<string, ModelProvider>;
  budget?: Budget;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
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

  let completion;
  try {
    completion = await models.completeStructured({
      tier: "frontier",
      system: baselineSystemPrompt,
      // The request only. The fixture's acceptance criteria are the grader's, and handing
      // them to either system would leak the test into the system under test.
      input: {
        request: options.request,
        files
      },
      schemaName: "baseline_result_v1",
      schema: BaselineOutputSchema,
      stageBudget: budget,
      stageUsage: zeroUsage,
      runBudget: budget,
      runUsage: zeroUsage,
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
      modelCalls: record ? [record] : [],
      artifacts: producedArtifacts,
      usage: record?.usage ?? zeroUsage,
      latencyMs: Math.round(performance.now() - startedAt)
    };
  }

  const usage = completion.record.usage;
  producedArtifacts.push(
    await artifacts.writeText("baseline.patch", "baseline.patch", completion.output.patch)
  );

  const check = await actions.run<PatchResult>(
    "patch.check",
    { patch: completion.output.patch },
    {}
  );
  toolCalls.push(check.record);
  producedArtifacts.push(...check.artifacts);
  if (!check.output?.valid) {
    return {
      status: "failed",
      summary: check.output?.diagnostics || check.record.summary,
      changedFiles: check.output?.changedFiles ?? [],
      filesLoaded,
      toolCalls,
      modelCalls: [completion.record],
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
    modelCalls: [completion.record],
    artifacts: producedArtifacts,
    usage: addUsage(zeroUsage, usage),
    latencyMs: Math.round(performance.now() - startedAt)
  };
}
