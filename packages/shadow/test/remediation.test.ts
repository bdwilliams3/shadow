import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";

const execFileAsync = promisify(execFile);

function diff(from: string, to: string): string {
  return [
    "diff --git a/hello.txt b/hello.txt",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    `-${from}`,
    `+${to}`,
    ""
  ].join("\n");
}

/** The suite only passes once hello.txt reads "new", so the first patch must fail it. */
const checkScript = [
  'import { readFileSync } from "node:fs";',
  'const value = readFileSync("hello.txt", "utf8").trim();',
  'if (value !== "new") {',
  '  console.error(`hello.txt is ${value}, expected new`);',
  "  process.exit(1);",
  "}",
  ""
].join("\n");

async function buildWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-remediation-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  await writeFile(join(workspace, "check.js"), checkScript, "utf8");
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "remediation", private: true, type: "module", scripts: { test: "node check.js" } }, null, 2)}\n`,
    "utf8"
  );
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "init"],
    { cwd: workspace }
  );
  return workspace;
}

const config = {
  ...defaultConfig,
  lifecycle: { ...defaultConfig.lifecycle, maxStageRetries: 0, maxRemediationCycles: 1 }
};

describe("develop remediation loop", () => {
  it("routes a test failure back to Develop as a compact artifact and recovers", async () => {
    const workspace = await buildWorkspace();
    const inputs: unknown[] = [];
    let developCalls = 0;
    const provider: ModelProvider = {
      async complete(request) {
        inputs.push(request.input);
        developCalls += 1;
        return {
          text: JSON.stringify({
            summary: developCalls === 1 ? "First attempt." : "Remediated attempt.",
            patch: developCalls === 1 ? diff("old", "wrong") : diff("wrong", "new"),
            decisions: [],
            openRisks: []
          }),
          usage: { inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0 }
        };
      }
    };
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(config, store, {
      providers: new Map([["default", provider]])
    });

    const run = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("COMPLETED");
    expect(developCalls).toBe(2);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");

    const develop = run.stageRuns.find((stage) => stage.stage === "develop");
    const test = run.stageRuns.find((stage) => stage.stage === "test");
    expect(develop?.attempts).toBe(2);
    expect(develop?.status).toBe("completed");
    expect(test?.status).toBe("completed");
    expect(test?.attemptResults.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);

    const events = await store.listEvents(run.id);
    const remediation = events.find((event) => event.type === "run.remediation_started");
    expect(remediation).toBeDefined();
    expect(remediation?.payload.failedStage).toBe("test");
    expect(remediation?.payload.cycle).toBe(1);

    // The second Develop call saw compact failure evidence, not raw test output.
    const second = inputs[1] as { priorFailures?: string[] };
    expect(second.priorFailures).toBeDefined();
    expect(second.priorFailures?.join("\n")).toContain('"stage": "test"');
    expect(inputs[0]).not.toHaveProperty("priorFailures");
  });

  it("fails the run when the remediation budget is exhausted", async () => {
    const workspace = await buildWorkspace();
    let developCalls = 0;
    const provider: ModelProvider = {
      async complete() {
        developCalls += 1;
        return {
          text: JSON.stringify({
            summary: "Never fixes the failure.",
            patch: developCalls === 1 ? diff("old", "wrong") : diff("wrong", "still-wrong"),
            decisions: [],
            openRisks: []
          }),
          usage: { inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0 }
        };
      }
    };
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(config, store, {
      providers: new Map([["default", provider]])
    });

    const run = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("FAILED");
    // One original pass plus exactly one remediation cycle.
    expect(developCalls).toBe(2);
    const events = await store.listEvents(run.id);
    expect(events.filter((event) => event.type === "run.remediation_started")).toHaveLength(1);
  });

  it("does not remediate during a dry run", async () => {
    const workspace = await buildWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(config, store);

    const run = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: true
    });

    const events = await store.listEvents(run.id);
    expect(events.some((event) => event.type === "run.remediation_started")).toBe(false);
  });
});
