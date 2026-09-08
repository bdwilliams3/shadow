import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  formatProgressEvent,
  formatRunBudget,
  formatRunChangedFiles,
  formatRunPlan,
  formatStageModelMap
} from "../src/cli/format.js";
import type { Run, RunEvent } from "../src/orchestration/types.js";

const run: Run = {
  id: "run-1",
  workspaceRoot: "/tmp/project",
  request: "add a timeout",
  state: "COMPLETED",
  dryRun: false,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:01.000Z",
  stageTasks: [
    {
      id: "stage-1",
      runId: "run-1",
      stage: "develop",
      goal: "add a timeout",
      inputs: [],
      constraints: [],
      allowedTools: [],
      writePermissions: true,
      acceptanceCriteria: ["timeout has a numeric default"],
      budget: defaultConfig.budgets.stage,
      retryCount: 0
    }
  ],
  stageRuns: [
    {
      id: "stage-1",
      runId: "run-1",
      stage: "develop",
      status: "completed",
      modelTier: defaultConfig.agents.develop,
      attempts: 1,
      attemptResults: [],
      result: {
        status: "completed",
        summary: "changed config",
        decisions: [],
        artifacts: [],
        changedFiles: ["core/config.py", "core/config.py"],
        toolCalls: [],
        modelCalls: [],
        testResults: [],
        openRisks: [],
        usage: { inputTokens: 100, outputTokens: 25, estimatedCostUsd: 0.01 }
      }
    }
  ],
  approvals: [],
  usage: { inputTokens: 100, outputTokens: 25, estimatedCostUsd: 0.01 },
  openRisks: []
};

describe("CLI format helpers", () => {
  it("formats stage aliases with spend visibility", () => {
    const text = formatStageModelMap(defaultConfig);

    expect(text).toContain("chat");
    expect(text).toContain("fable-5-1 -> anthropic/fable-5.1 (reserved)");
    expect(text).toContain("plan");
    expect(text).toContain("fable-5-1 -> anthropic/fable-5.1 (reserved)");
    expect(text).toContain("test");
    expect(text).toContain("(deterministic)");
  });

  it("formats run plan, budget, and changed files for slash commands", () => {
    expect(formatRunPlan(run)).toContain("1. develop: add a timeout");
    expect(formatRunPlan(run)).toContain("done: timeout has a numeric default");
    expect(formatRunBudget(run, defaultConfig)).toContain("Run tokens: 125/");
    expect(formatRunChangedFiles(run)).toBe("core/config.py");
  });

  it("formats progress events into compact live updates", () => {
    const event: RunEvent = {
      id: "event-1",
      runId: "run-1",
      type: "stage.completed",
      createdAt: "2026-09-08T00:00:01.000Z",
      payload: {
        stage: "develop",
        status: "completed",
        summary: "changed config"
      }
    };

    expect(formatProgressEvent(event)).toBe("develop completed: changed config");
  });
});
