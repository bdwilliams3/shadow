import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider, ModelRequest } from "../src/models/provider.js";
import { TestRunSummarySchema } from "../src/mcp/tests/types.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";

const execFileAsync = promisify(execFile);

function implementationPatch(): string {
  return [
    "diff --git a/hello.txt b/hello.txt",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ""
  ].join("\n");
}

function documentationPatch(): string {
  return [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,3 @@",
    " # Fixture",
    "+",
    "+The hello behavior now returns new.",
    ""
  ].join("\n");
}

describe("Design and Document agents", () => {
  it("passes structured implementation artifacts through a complete lifecycle", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-lifecycle-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
    await writeFile(join(workspace, "README.md"), "# Fixture\n", "utf8");
    await writeFile(join(workspace, "package.json"), '{"name":"fixture"}\n', "utf8");
    await execFileAsync("git", ["add", "."], { cwd: workspace });

    let documentInput: unknown;
    const provider: ModelProvider = {
      async complete(request: ModelRequest) {
        const schema = request.outputSchema?.name;
        if (schema === "shadow_design_result_v1") {
          return response({
            summary: "Designed a bounded text behavior change.",
            decisions: [{
              title: "Scope",
              decision: "Change hello.txt only.",
              rationale: "The request is local.",
              consequences: []
            }],
            interfaces: [],
            migration: [],
            openRisks: []
          });
        }
        if (schema === "shadow_develop_result_v1") {
          return response({
            summary: "Updated hello.txt.",
            patch: implementationPatch(),
            decisions: [],
            openRisks: []
          });
        }
        if (schema === "shadow_document_result_v1") {
          documentInput = request.input;
          return response({
            summary: "Documented the completed behavior.",
            patch: documentationPatch(),
            changeSummary: ["Documented hello behavior."],
            migrationNotes: [],
            operationalNotes: [],
            decisions: [],
            openRisks: []
          });
        }
        throw new Error(`Unexpected schema ${schema}`);
      }
    };
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const run = await new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["anthropic", provider], ["google", provider], ["openai", provider]]),
      testsExecutor: {
        async runTests() {
          return TestRunSummarySchema.parse({
            run_id: "tests",
            framework: "vitest",
            status: "passed",
            counts: { passed: 1, failed: 0, skipped: 0 },
            duration_ms: 1,
            attempts: 1
          });
        }
      }
    }).run({
      request: "create project behavior that changes hello from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("COMPLETED");
    expect(run.stageRuns.map((stage) => [stage.stage, stage.status])).toEqual([
      ["plan", "completed"],
      ["design", "completed"],
      ["develop", "completed"],
      ["test", "completed"],
      ["validate", "completed"],
      ["document", "completed"]
    ]);
    expect(run.stageRuns.find((stage) => stage.stage === "design")?.result?.artifacts
      .some((artifact) => artifact.kind === "design.result")).toBe(true);
    const evidence = (documentInput as {
      implementationEvidence: Array<{ kind: string; content: string }>;
    }).implementationEvidence;
    expect(evidence.some((artifact) =>
      artifact.kind === "develop.patch" && artifact.content.includes("+new")
    )).toBe(true);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toContain(
      "The hello behavior now returns new."
    );
  });
});

function response(value: unknown) {
  return {
    text: JSON.stringify(value),
    usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.001 }
  };
}
