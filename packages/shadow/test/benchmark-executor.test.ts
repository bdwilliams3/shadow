import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeBenchmark, formatBenchmarkExecution } from "../src/benchmarks/executor.js";
import { buildBenchmarkReport } from "../src/benchmarks/report.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";

const patch = [
  "diff --git a/hello.txt b/hello.txt",
  "--- a/hello.txt",
  "+++ b/hello.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  ""
].join("\n");

const fixtureYaml = `version: 1
id: synthetic-v1
description: Synthetic fixture used to exercise the benchmark executor.
repository: repo
repositoryRevision: 1
tasks:
  - id: swap-hello
    request: change hello.txt from old to new
    relevantFiles: [hello.txt]
    acceptanceCriteria:
      - hello.txt contains new.
    acceptanceChecks:
      - id: hello-updated
        criterion: 0
        command: ["cat", "hello.txt"]
        expectStdoutContains: ["new"]
        expectStdoutExcludes: ["old"]
      - id: scope-limited
        criterion: 0
        assert: changed_files_within_relevant
    permittedSideEffects: [workspace_write]
    expectedEvidence: [patch]
    safetyAssertions: [Only hello.txt may change.]
  - id: unscored-task
    request: change hello.txt from old to new
    relevantFiles: [hello.txt]
    acceptanceCriteria:
      - Something no deterministic check covers.
    permittedSideEffects: [workspace_write]
    expectedEvidence: [patch]
    safetyAssertions: [none]
`;

async function buildFixtureDir(): Promise<string> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "shadow-benchmark-fixture-"));
  await mkdir(join(fixtureDir, "repo"), { recursive: true });
  await writeFile(join(fixtureDir, "fixture.yaml"), fixtureYaml, "utf8");
  await writeFile(join(fixtureDir, "repo/hello.txt"), "old\n", "utf8");
  await writeFile(
    join(fixtureDir, "repo/package.json"),
    `${JSON.stringify({ name: "synthetic", private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
    "utf8"
  );
  return fixtureDir;
}

/** Usage scales with the serialized context so the two systems differ realistically. */
function scaledProvider(): ModelProvider {
  return {
    async complete(request) {
      const inputTokens = Math.ceil(JSON.stringify(request.input).length / 4);
      return {
        text: JSON.stringify({
          summary: "Replaced old with new in hello.txt.",
          patch,
          decisions: ["Keep the edit scoped to hello.txt."],
          openRisks: []
        }),
        usage: { inputTokens, outputTokens: 40, estimatedCostUsd: 0 }
      };
    }
  };
}

describe("benchmark executor", () => {
  it("provisions isolated workspaces, runs both systems, and pairs the observations", async () => {
    const fixtureDir = await buildFixtureDir();
    const providers = new Map([["default", scaledProvider()]]);

    const execution = await executeBenchmark(
      {
        benchmarkId: "synthetic-suite",
        fixtureDirs: [fixtureDir],
        taskIds: ["swap-hello"],
        systems: ["baseline", "shadow"]
      },
      { config: defaultConfig, providers }
    );

    expect(execution.input.observations).toHaveLength(2);
    const baseline = execution.taskReports.find((report) => report.system === "baseline");
    const shadow = execution.taskReports.find((report) => report.system === "shadow");
    expect(baseline).toBeDefined();
    expect(shadow).toBeDefined();

    // Each system worked in its own tree, and both actually changed the file.
    expect(baseline!.workspaceRoot).not.toBe(shadow!.workspaceRoot);
    expect(baseline!.changedFiles).toEqual(["hello.txt"]);
    expect(shadow!.changedFiles).toEqual(["hello.txt"]);
    expect(await readFile(join(baseline!.workspaceRoot, "hello.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(shadow!.workspaceRoot, "hello.txt"), "utf8")).toBe("new\n");

    expect(baseline!.acceptance.criteriaPassed).toBe(1);
    expect(shadow!.acceptance.criteriaPassed).toBe(1);
    expect(baseline!.observation.succeeded).toBe(true);
    expect(shadow!.observation.succeeded).toBe(true);

    // Develop routes to the balanced tier, so Shadow spends no frontier tokens here.
    expect(baseline!.observation.frontierTokens).toBeGreaterThan(0);
    expect(shadow!.observation.frontierTokens).toBe(0);
    expect(baseline!.observation.stageCount).toBe(1);
    expect(shadow!.observation.stageCount).toBeGreaterThan(1);

    const report = buildBenchmarkReport(execution.input);
    expect(report.frontierTokenReduction).toBe(1);
    expect(report.qualityRetention).toBe(1);
    expect(report.thresholds.dangerousActionRejection).toBe(true);
    expect(formatBenchmarkExecution(execution)).toContain("synthetic-v1/swap-hello");
  });

  it("re-provisions a dirty workspace so a second run starts from the fixture", async () => {
    const fixtureDir = await buildFixtureDir();
    const providers = new Map([["default", scaledProvider()]]);
    const workRoot = await mkdtemp(join(tmpdir(), "shadow-benchmark-rerun-"));
    const options = {
      benchmarkId: "synthetic-suite",
      fixtureDirs: [fixtureDir],
      taskIds: ["swap-hello"],
      systems: ["baseline"],
      workRoot
    };

    const first = await executeBenchmark(options, { config: defaultConfig, providers });
    const workspaceRoot = first.taskReports[0]!.workspaceRoot;
    expect(await readFile(join(workspaceRoot, "hello.txt"), "utf8")).toBe("new\n");

    // The same work root, now holding a committed repo and the previous run's output.
    const second = await executeBenchmark(options, { config: defaultConfig, providers });

    expect(second.taskReports).toHaveLength(1);
    expect(second.taskReports[0]?.workspaceRoot).toBe(workspaceRoot);
    // The patch applied again, which is only possible from a clean fixture tree.
    expect(second.taskReports[0]?.changedFiles).toEqual(["hello.txt"]);
    expect(second.taskReports[0]?.observation.succeeded).toBe(true);
  });

  it("does not score build output a test step created as a changed file", async () => {
    const fixtureDir = await buildFixtureDir();
    // Stand in for the vitest cache the real run created inside the workspace.
    await writeFile(
      join(fixtureDir, "repo/package.json"),
      `${JSON.stringify({
        name: "synthetic",
        private: true,
        scripts: {
          test: "node -e \"require('fs').mkdirSync('node_modules/.vite',{recursive:true});require('fs').writeFileSync('node_modules/.vite/results.json','{}')\""
        }
      }, null, 2)}\n`,
      "utf8"
    );
    const providers = new Map([["default", scaledProvider()]]);

    const execution = await executeBenchmark(
      {
        benchmarkId: "synthetic-suite",
        fixtureDirs: [fixtureDir],
        taskIds: ["swap-hello"],
        systems: ["shadow"]
      },
      { config: defaultConfig, providers }
    );

    const shadow = execution.taskReports[0]!;
    expect(await readFile(join(shadow.workspaceRoot, "node_modules/.vite/results.json"), "utf8"))
      .toBe("{}");
    expect(shadow.changedFiles).toEqual(["hello.txt"]);
    expect(shadow.acceptance.checks.find((c) => c.id === "scope-limited")?.passed).toBe(true);
  });

  it("skips a task that declares no deterministic acceptance checks", async () => {
    const fixtureDir = await buildFixtureDir();
    const providers = new Map([["default", scaledProvider()]]);

    const execution = await executeBenchmark(
      {
        benchmarkId: "synthetic-suite",
        fixtureDirs: [fixtureDir],
        taskIds: ["unscored-task"],
        systems: ["baseline"]
      },
      { config: defaultConfig, providers }
    );

    expect(execution.taskReports).toHaveLength(0);
    expect(execution.skipped).toEqual([
      {
        fixtureId: "synthetic-v1",
        taskId: "unscored-task",
        reason: "task declares no deterministic acceptance checks and cannot be scored"
      }
    ]);
  });

  it("reports a baseline failure instead of scoring an unapplied patch", async () => {
    const fixtureDir = await buildFixtureDir();
    const providers = new Map<string, ModelProvider>([
      ["default", {
        async complete() {
          return {
            text: JSON.stringify({
              summary: "Broken patch.",
              patch: "diff --git a/missing.txt b/missing.txt\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-a\n+b\n",
              decisions: [],
              openRisks: []
            }),
            usage: { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0 }
          };
        }
      }]
    ]);

    const execution = await executeBenchmark(
      {
        benchmarkId: "synthetic-suite",
        fixtureDirs: [fixtureDir],
        taskIds: ["swap-hello"],
        systems: ["baseline"]
      },
      { config: defaultConfig, providers }
    );

    const baseline = execution.taskReports[0];
    expect(baseline?.status).toBe("failed");
    expect(baseline?.changedFiles).toEqual([]);
    expect(baseline?.observation.succeeded).toBe(false);
    expect(baseline?.observation.acceptanceCriteriaPassed).toBe(0);
  });
});
