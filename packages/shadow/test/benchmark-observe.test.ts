import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { buildShadowObservation } from "../src/benchmarks/observe.js";
import type { Run, StageResult } from "../src/orchestration/types.js";

describe("benchmark observation capture", () => {
  it("derives usage, retries, intervention, and context relevance from a durable run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-benchmark-observe-"));
    const artifacts = new ArtifactStore(join(workspace, ".shadow/artifacts"));
    const contextArtifact = await artifacts.writeText("action.result", "context.select.result.json", `${JSON.stringify({
      files: [
        { path: "src/target.ts", sha256: "a".repeat(64), bytes: 10, content: "target", truncated: false, redacted: false },
        { path: "src/noise.ts", sha256: "b".repeat(64), bytes: 10, content: "noise", truncated: false, redacted: false }
      ],
      totalBytes: 20,
      omittedFiles: 0,
      selectionTerms: ["target"],
      redactionCount: 0
    })}\n`);
    const result: StageResult = {
      status: "completed",
      summary: "done",
      decisions: [],
      artifacts: [contextArtifact],
      changedFiles: ["src/target.ts"],
      toolCalls: [{
        actionId: "context.select",
        actionVersion: 2,
        status: "completed",
        cwd: workspace,
        commands: [],
        exitCode: 0,
        durationMs: 10,
        summary: "selected",
        approvalRequired: false,
        artifacts: [contextArtifact]
      }],
      modelCalls: [{
        id: "model-call",
        tier: "gpt-5-6-luna",
        modelAlias: "gpt-5-6-luna",
        frontier: false,
        provider: "provider",
        model: "model",
        status: "completed",
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
        durationMs: 100,
        usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.2 },
        approvalRequired: false
      }],
      testResults: [],
      openRisks: [],
      usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.2 }
    };
    const run: Run = {
      id: "run-1",
      workspaceRoot: workspace,
      request: "change target",
      state: "COMPLETED",
      dryRun: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      stageTasks: [],
      stageRuns: [{
        id: "stage-1",
        runId: "run-1",
        stage: "develop",
        status: "completed",
        modelTier: "frontier",
        attempts: 2,
        attemptResults: [{ ...result, status: "failed" }, result],
        result
      }],
      approvals: [{
        id: "approval-1",
        runId: "run-1",
        stageTaskId: "stage-1",
        stage: "develop",
        operation: "patch.apply",
        reasons: ["approval configured"],
        status: "approved",
        createdAt: "2026-01-01T00:00:00.500Z",
        resolvedAt: "2026-01-01T00:00:01.000Z"
      }],
      usage: { inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.4 },
      openRisks: []
    };

    const observation = await buildShadowObservation(run, {
      fixtureId: "typescript-app-v1",
      taskId: "target-change",
      acceptanceCriteriaPassed: 3,
      acceptanceCriteriaTotal: 3,
      relevantFiles: ["src/target.ts"],
      dangerousOperations: [],
      baselineModel: "provider/model"
    }, artifacts);

    expect(observation).toMatchObject({
      system: "shadow",
      succeeded: true,
      frontierTokens: 300,
      totalTokens: 300,
      modelUsage: [
        {
          provider: "provider",
          model: "model",
          modelAlias: "gpt-5-6-luna",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: 0.2
        },
        {
          provider: "provider",
          model: "model",
          modelAlias: "gpt-5-6-luna",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: 0.2
        }
      ],
      latencyMs: 2_000,
      humanInterventions: 1,
      // One distinct irrelevant path, even though two attempts each selected it.
      irrelevantFilesLoaded: 1,
      stageCount: 1,
      retries: 1
    });
  });

  it("rejects observations from an unfinished run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-benchmark-observe-"));
    const run = {
      id: "run-2",
      state: "EXECUTING"
    } as Run;

    await expect(buildShadowObservation(run, {
      fixtureId: "fixture",
      taskId: "task",
      acceptanceCriteriaPassed: 1,
      acceptanceCriteriaTotal: 1
    }, new ArtifactStore(join(workspace, ".shadow/artifacts")))).rejects.toThrow("not terminal");
  });
});
