import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { resolveModelAlias } from "../src/config/schema.js";
import type { ModelProvider } from "../src/models/provider.js";
import { TestRunSummarySchema } from "../src/mcp/tests/types.js";
import type { TestRunRequest } from "../src/mcp/tests/types.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { withPlanStage } from "./support/plan-provider.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";

const execFileAsync = promisify(execFile);

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-controls-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  await writeFile(join(workspace, "hello.test.ts"), "export const covered = true;\n", "utf8");
  await writeFile(join(workspace, "package.json"), '{"name":"controls-fixture"}\n', "utf8");
  await execFileAsync("git", ["add", "hello.txt", "hello.test.ts", "package.json"], { cwd: workspace });
  return workspace;
}

function updatePatch(replacement = "new"): string {
  return [
    "diff --git a/hello.txt b/hello.txt",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-old",
    `+${replacement}`,
    ""
  ].join("\n");
}

function response(patch: string) {
  return {
    text: JSON.stringify({ summary: "Updated hello.txt.", patch, decisions: [], openRisks: [] }),
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 }
  };
}

describe("orchestration controls", () => {
  it("pauses each model-backed stage for its own approval and resumes only that stage", async () => {
    const workspace = await fixtureWorkspace();
    const config = structuredClone(defaultConfig);
    config.approvals.requireApprovalForNetwork = true;
    config.lifecycle.maxModelCallsPerStage = 1;
    let developCalls = 0;
    const provider = withPlanStage({
      async complete() {
        developCalls += 1;
        return response(updatePatch());
      }
    });
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(config, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    });

    // Plan is the first stage to reach a provider, and it does so while the run is still
    // PLANNED, so this also covers the PLANNED -> AWAITING_APPROVAL transition.
    const awaitingPlan = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(awaitingPlan.state).toBe("AWAITING_APPROVAL");
    expect(awaitingPlan.approvals).toHaveLength(1);
    expect(awaitingPlan.approvals[0]).toMatchObject({
      stage: "plan",
      operation: "model.complete",
      status: "pending"
    });
    expect(developCalls).toBe(0);

    await store.resolveApproval(awaitingPlan.id, awaitingPlan.approvals[0]!.id, "approved");
    const awaitingDevelop = await orchestrator.resume(awaitingPlan.id);

    // Approving Plan's call does not approve Develop's: each stage is asked separately.
    expect(awaitingDevelop.state).toBe("AWAITING_APPROVAL");
    expect(awaitingDevelop.approvals).toHaveLength(2);
    expect(awaitingDevelop.approvals[1]).toMatchObject({
      stage: "develop",
      operation: "model.complete",
      status: "pending"
    });
    const planAttempts = awaitingDevelop.stageRuns.find((stage) => stage.stage === "plan")?.attempts;
    expect(developCalls).toBe(0);

    await store.resolveApproval(awaitingDevelop.id, awaitingDevelop.approvals[1]!.id, "approved");
    const completed = await orchestrator.resume(awaitingDevelop.id);

    expect(completed.state).toBe("COMPLETED");
    expect(completed.approvals.every((approval) => approval.status === "approved")).toBe(true);
    // Plan is not re-run once it has completed.
    expect(completed.stageRuns.find((stage) => stage.stage === "plan")?.attempts).toBe(planAttempts);
    expect(completed.stageRuns.find((stage) => stage.stage === "develop")?.attempts).toBe(2);
    expect(developCalls).toBe(1);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");
  });

  it("retries a failed Develop result within configured limits", async () => {
    const workspace = await fixtureWorkspace();
    let providerCalls = 0;
    const provider = withPlanStage({
      async complete() {
        providerCalls += 1;
        return response(providerCalls === 1 ? "not a patch" : updatePatch());
      }
    });
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    let testRequest: TestRunRequest | undefined;
    const orchestrator = new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]]),
      testsExecutor: {
        async runTests(request) {
          testRequest = request;
          return TestRunSummarySchema.parse({
            run_id: "test-run",
            framework: "vitest",
            status: "passed",
            counts: { passed: 1, failed: 0, skipped: 0 },
            duration_ms: 5,
            attempts: 1
          });
        }
      }
    });

    const run = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });
    const develop = run.stageRuns.find((stage) => stage.stage === "develop");

    expect(run.state).toBe("COMPLETED");
    expect(develop?.attempts).toBe(2);
    expect(develop?.attemptResults.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(providerCalls).toBe(2);
    expect(run.usage.inputTokens).toBe(20);
    expect(run.stageRuns.find((stage) => stage.stage === "test")?.result?.toolCalls
      .some((call) => call.actionId === "mcp.tests.run_tests")).toBe(true);
    expect(testRequest?.selectors).toEqual(["hello.test.ts"]);
  });

  it("applies prior attempt usage to the stage budget before retrying", async () => {
    const workspace = await fixtureWorkspace();
    const config = structuredClone(defaultConfig);
    const developAlias = resolveModelAlias(config, config.agents.develop);
    expect(developAlias).toBeDefined();
    config.providers[developAlias!.provider]!.models[developAlias!.alias]!.maxOutputTokens = 100;
    config.budgets.stage.maxInputTokens = 4_000;
    config.budgets.stage.maxOutputTokens = 4_000;
    config.budgets.stage.maxTotalTokens = 3_000;
    config.budgets.stage.reservedFrontierTokens = 0;
    let providerCalls = 0;
    const provider = withPlanStage({
      async complete() {
        providerCalls += 1;
        return {
          ...response("not a patch"),
          usage: { inputTokens: 2_500, outputTokens: 100, estimatedCostUsd: 0.001 }
        };
      }
    });
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const run = await new LifecycleOrchestrator(config, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("FAILED");
    expect(providerCalls).toBe(1);
    expect(run.stageRuns.find((stage) => stage.stage === "develop")?.attemptResults
      .flatMap((attempt) => attempt.modelCalls).map((call) => call.status)).toEqual([
        "completed",
        "blocked"
      ]);
  });

  it("cancels an active provider request and preserves the workspace", async () => {
    const workspace = await fixtureWorkspace();
    let started!: (signal: AbortSignal | undefined) => void;
    const providerStarted = new Promise<AbortSignal | undefined>((resolve) => {
      started = resolve;
    });
    const provider = withPlanStage({
      async complete(request) {
        started(request.signal);
        return new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true }
          );
        });
      }
    });
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]]),
      cancellationPollMs: 10
    });
    const running = orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    const signal = await providerStarted;
    const active = (await store.listRuns())[0];
    expect(active).toBeDefined();
    await store.requestCancellation(active!.id);
    const cancelled = await running;

    expect(signal?.aborted).toBe(true);
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.stageRuns.find((stage) => stage.stage === "develop")?.status).toBe("cancelled");
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("old\n");
  });

  it("rejecting an approval cancels the durable run", async () => {
    const workspace = await fixtureWorkspace();
    const config = structuredClone(defaultConfig);
    config.approvals.requireApprovalForNetwork = true;
    const provider: ModelProvider = { complete: async () => response(updatePatch()) };
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(config, store, {
      providers: new Map([
        ["anthropic", provider],
        ["google", provider],
        ["openai", provider]
      ])
    });
    const waiting = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    const rejected = await store.resolveApproval(waiting.id, undefined, "rejected");

    expect(rejected?.state).toBe("CANCELLED");
    expect(rejected?.approvals[0]?.status).toBe("rejected");
  });

  it("resumes an interrupted stage without replaying completed stages", async () => {
    const workspace = await fixtureWorkspace();
    const provider: ModelProvider = {
      async complete() {
        return response(updatePatch());
      }
    };
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    });
    const completed = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });
    const planAttempts = completed.stageRuns.find((stage) => stage.stage === "plan")!.attempts;
    const validate = completed.stageRuns.find((stage) => stage.stage === "validate")!;
    const validateAttempts = validate.attempts;
    completed.state = "VALIDATING";
    validate.status = "running";
    delete validate.result;
    delete validate.completedAt;
    await store.updateRun(completed);

    const resumed = await orchestrator.resume(completed.id);

    expect(resumed.state).toBe("COMPLETED");
    expect(resumed.stageRuns.find((stage) => stage.stage === "plan")?.attempts).toBe(planAttempts);
    expect(resumed.stageRuns.find((stage) => stage.stage === "validate")?.attempts).toBe(
      validateAttempts + 1
    );
  });
});
