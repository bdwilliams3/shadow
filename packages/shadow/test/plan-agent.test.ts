import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  maxCriteriaPerStage,
  scoreComplexity,
  toPlanRevision,
  type PlanOutput
} from "../src/agents/plan-agent.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";
import { describeSchemaFailure } from "../src/models/router.js";
import { isPlanRequest, planResponse } from "./support/plan-provider.js";

const execFileAsync = promisify(execFile);

const patch = [
  "diff --git a/hello.txt b/hello.txt",
  "--- a/hello.txt",
  "+++ b/hello.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  ""
].join("\n");

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-plan-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    "utf8"
  );
  await execFileAsync("git", ["add", "hello.txt", "package.json"], { cwd: workspace });
  return workspace;
}

function planOutput(overrides: Partial<PlanOutput> = {}): PlanOutput {
  return {
    stages: ["develop", "test", "validate"],
    tasks: [],
    risks: [],
    ...overrides
  };
}

/** Answers Plan with the given plan and every other stage with a working patch. */
function providerFor(plan: PlanOutput, onDevelop?: () => void): ModelProvider {
  return {
    async complete(request) {
      if (isPlanRequest(request)) {
        return {
          text: JSON.stringify(plan),
          usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 }
        };
      }
      onDevelop?.();
      return {
        text: JSON.stringify({ summary: "Edited.", patch, decisions: [], openRisks: [] }),
        usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 }
      };
    }
  };
}

describe("toPlanRevision", () => {
  it("drops Plan itself and de-duplicates the stage list", () => {
    const revision = toPlanRevision(
      planOutput({ stages: ["plan", "develop", "develop", "test"] }),
      "req"
    );
    expect(revision?.stages).toEqual(["develop", "test"]);
  });

  it("returns nothing when a plan names no stage other than itself", () => {
    expect(toPlanRevision(planOutput({ stages: [] }), "req")).toBeUndefined();
    expect(toPlanRevision(planOutput({ stages: ["plan"] }), "req")).toBeUndefined();
  });

  it("keeps acceptance criteria only for the stages that consume them", () => {
    const revision = toPlanRevision(
      planOutput({
        stages: ["develop", "test"],
        tasks: [
          {
            stage: "develop",
            acceptanceCriteria: ["hello.txt reads new"],
            recommendedTier: "unspecified"
          },
          {
            stage: "test",
            // Deterministic stages take no criteria however insistent the plan is.
            acceptanceCriteria: ["the suite passes"],
            recommendedTier: "unspecified"
          }
        ]
      }),
      "req"
    );
    expect(revision?.tasks.find((task) => task.stage === "develop")?.acceptanceCriteria)
      .toEqual(["hello.txt reads new"]);
    expect(revision?.tasks.find((task) => task.stage === "test")?.acceptanceCriteria).toEqual([]);
  });

  it("caps criteria per stage and discards blank ones", () => {
    const revision = toPlanRevision(
      planOutput({
        stages: ["develop"],
        tasks: [
          {
            stage: "develop",
            acceptanceCriteria: ["  ", "a", "b", "c", "d", "e", "f"],
            recommendedTier: "unspecified"
          }
        ]
      }),
      "the original request"
    );
    const develop = revision?.tasks[0];
    expect(develop?.acceptanceCriteria).toEqual(["a", "b", "c", "d"].slice(0, maxCriteriaPerStage));
    // An empty goal falls back to the request rather than producing an unusable task.
    expect(develop?.goal).toBe("the original request");
  });
});

describe("scoreComplexity", () => {
  it("scores a small single-language repository low and a broad one high", () => {
    const small = scoreComplexity(
      {
        fileCount: 3,
        indexedFileCount: 3,
        updatedFiles: 0,
        removedFiles: 0,
        unchangedFiles: 3,
        truncated: false,
        source: "git",
        languages: { typescript: 3 },
        manifests: ["package.json"],
        sampleFiles: []
      },
      { repository: true, clean: true, changedFiles: [], entries: [] },
      "fix a typo"
    );
    expect(small.score).toBe("low");

    const broad = scoreComplexity(
      {
        fileCount: 900,
        indexedFileCount: 900,
        updatedFiles: 0,
        removedFiles: 0,
        unchangedFiles: 900,
        truncated: false,
        source: "git",
        languages: { typescript: 400, python: 400, go: 100 },
        manifests: ["package.json", "pyproject.toml"],
        sampleFiles: []
      },
      {
        repository: true,
        clean: false,
        changedFiles: Array.from({ length: 20 }, (_, index) => `f${index}.ts`),
        entries: []
      },
      "fix a typo"
    );
    expect(broad.score).toBe("high");
  });
});

describe("model-backed Plan stage", () => {
  it("revises the lifecycle graph and gives Develop real acceptance criteria", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider = providerFor(
      planOutput({
        // The deterministic bootstrap for this request would not include design.
        stages: ["design", "develop", "test", "validate"],
        tasks: [
          {
            stage: "develop",
            acceptanceCriteria: ["hello.txt contains new"],
            recommendedTier: "unspecified"
          }
        ]
      })
    );
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    expect(run.state).toBe("COMPLETED");
    expect(run.stageTasks.map((task) => task.stage)).toEqual([
      "plan",
      "design",
      "develop",
      "test",
      "validate"
    ]);
    const develop = run.stageTasks.find((task) => task.stage === "develop");
    expect(develop?.acceptanceCriteria).toEqual(["hello.txt contains new"]);
    // The goal is the user's request verbatim. Having the model restate it per stage
    // cost output tokens at the frontier rate to say what we already had.
    expect(develop?.goal).toBe("change hello.txt from old to new");
    // Tools and write permissions stay with the stage table, not the plan.
    expect(develop?.allowedTools).toContain("patch.apply");
    expect(develop?.writePermissions).toBe(true);

    const events = await store.listEvents(run.id);
    const replanned = events.find((event) => event.type === "run.replanned");
    expect(replanned?.payload).toMatchObject({ after: ["design", "develop", "test", "validate"] });
  });

  it("preserves explicit acceptance criteria over broader Plan criteria", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider = providerFor(
      planOutput({
        stages: ["develop", "test", "validate"],
        tasks: [
          {
            stage: "develop",
            acceptanceCriteria: [
              "hello.txt contains new",
              "also update unrelated call sites"
            ],
            recommendedTier: "unspecified"
          }
        ]
      })
    );
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false,
      allowedChangedFiles: ["hello.txt"],
      acceptanceCriteria: ["hello.txt contains new"]
    });

    expect(run.state).toBe("COMPLETED");
    const develop = run.stageTasks.find((task) => task.stage === "develop");
    expect(develop?.acceptanceCriteria).toEqual(["hello.txt contains new"]);
  });

  it("drops a stage the plan omits and never re-adds Plan itself", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider = providerFor(planOutput({ stages: ["plan", "develop"] }));
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    expect(run.state).toBe("COMPLETED");
    expect(run.stageTasks.map((task) => task.stage)).toEqual(["plan", "develop"]);
    expect(run.stageRuns.map((stage) => stage.stage)).toEqual(["plan", "develop"]);
  });

  it("ignores stages configuration has disabled and records why", async () => {
    const workspace = await fixtureWorkspace();
    const config = structuredClone(defaultConfig);
    config.lifecycle.enabledStages = ["plan", "develop", "validate"];
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider = providerFor(planOutput({ stages: ["develop", "deploy", "validate"] }));
    const run = await new LifecycleOrchestrator(config, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    expect(run.stageTasks.map((task) => task.stage)).toEqual(["plan", "develop", "validate"]);
    expect(run.openRisks.some((risk) => risk.includes("disabled by configuration"))).toBe(true);
  });

  it("keeps configured model aliases when Plan recommends old capability labels", async () => {
    const workspace = await fixtureWorkspace();
    const config = structuredClone(defaultConfig);
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider = providerFor(
      planOutput({
        stages: ["develop", "validate"],
        tasks: [
          { stage: "develop", acceptanceCriteria: [], recommendedTier: "frontier" },
          { stage: "validate", acceptanceCriteria: [], recommendedTier: "economy" }
        ]
      })
    );
    const run = await new LifecycleOrchestrator(config, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    // Direct model aliases are configuration, not suggestions a model can rewrite.
    expect(run.stageRuns.find((stage) => stage.stage === "validate")?.modelTier).toBe("gemini-2-5");
    expect(run.stageRuns.find((stage) => stage.stage === "develop")?.modelTier).toBe("sonnet-4-6");
    expect(run.openRisks.some((risk) => risk.includes("Plan recommended frontier"))).toBe(true);
  });

  it("keeps the deterministic graph and completes the run when the provider fails", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    let developCalls = 0;
    const provider: ModelProvider = {
      async complete(request) {
        if (isPlanRequest(request)) {
          throw new Error("provider unreachable");
        }
        developCalls += 1;
        return {
          text: JSON.stringify({ summary: "Edited.", patch, decisions: [], openRisks: [] }),
          usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 }
        };
      }
    };
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    // An unreachable planner costs the plan, not the run.
    expect(run.state).toBe("COMPLETED");
    expect(developCalls).toBe(1);
    expect(run.stageTasks.map((task) => task.stage)).toEqual(["plan", "develop", "test", "validate"]);
    expect(run.stageRuns.find((stage) => stage.stage === "plan")?.status).toBe("completed");
    expect(
      run.openRisks.some((risk) => risk.includes("Model-backed planning was unavailable"))
    ).toBe(true);
  });

  it("keeps the deterministic graph when the plan names no runnable stage", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider = providerFor(planOutput({ stages: [] }));
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    expect(run.state).toBe("COMPLETED");
    expect(run.stageTasks.map((task) => task.stage)).toEqual(["plan", "develop", "test", "validate"]);
    expect(run.openRisks.some((risk) => risk.includes("no usable stage list"))).toBe(true);
  });

  it("pauses rather than falling back when the provider call needs approval", async () => {
    const workspace = await fixtureWorkspace();
    const config = structuredClone(defaultConfig);
    config.approvals.requireApprovalForNetwork = true;
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const run = await new LifecycleOrchestrator(config, store, {
      providers: new Map([
        ["anthropic", providerFor(planOutput())],
        ["google", providerFor(planOutput())],
        ["openai", providerFor(planOutput())]
      ])
    }).run({ request: "change hello.txt from old to new", workspaceRoot: workspace, dryRun: false });

    // An approval pause is a decision the user still has to make, not a failure to route
    // around with the deterministic planner.
    expect(run.state).toBe("AWAITING_APPROVAL");
    expect(run.approvals[0]).toMatchObject({ stage: "plan", operation: "model.complete" });
  });
});

describe("describeSchemaFailure", () => {
  it("reduces a Zod failure to one sentence naming the bad fields", () => {
    const schema = z.object({ summary: z.string().min(1), count: z.number() });
    const result = schema.safeParse({ summary: "", count: "no" });
    const described = describeSchemaFailure("shadow_develop_result_v1", result.error);

    // Previously this surfaced ZodError.message, a multi-line JSON array, straight into a
    // stage summary.
    expect(described).toContain("shadow_develop_result_v1");
    expect(described).toContain("summary");
    expect(described).toContain("count");
    expect(described).not.toContain("\n");
  });

  it("passes ordinary errors through unchanged", () => {
    expect(describeSchemaFailure("x", new Error("provider unreachable")))
      .toBe("provider unreachable");
  });
});

describe("declining with an empty summary", () => {
  it("still blocks the run with the decline reason rather than a schema error", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const provider: ModelProvider = {
      async complete(request) {
        if (isPlanRequest(request)) {
          return planResponse({ stages: ["develop", "test", "validate"] });
        }
        // A weak model declining correctly but leaving summary empty. This previously
        // failed schema validation, destroying the refusal.
        return {
          text: JSON.stringify({
            summary: "",
            patch: "",
            declineReason: "The request requires deletion outside the workspace.",
            decisions: [],
            openRisks: []
          }),
          usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 }
        };
      }
    };
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]])
    }).run({ request: "delete generated output outside the repo", workspaceRoot: workspace, dryRun: false });

    const develop = run.stageRuns.find((stage) => stage.stage === "develop");
    expect(develop?.status).toBe("blocked");
    expect(develop?.result?.summary).toContain("The request requires deletion outside the workspace.");
    expect(develop?.result?.summary).not.toContain("too_small");
  });
});
