import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { withPlanStage } from "./support/plan-provider.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";

const execFileAsync = promisify(execFile);

describe("DevelopAgent", () => {
  it("applies one validated model patch through the action runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-develop-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8"
    );
    await execFileAsync("git", ["add", "hello.txt", "package.json"], { cwd: workspace });

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");
    const provider = withPlanStage({
      async complete() {
        return {
          text: JSON.stringify({
            summary: "Updated the requested fixture.",
            patch,
            decisions: ["Keep the edit scoped to hello.txt."],
            openRisks: []
          }),
          usage: { inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.001 }
        };
      }
    });
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["default", provider]])
    });

    const run = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("COMPLETED");
    expect(run.stageRuns.find((stage) => stage.stage === "develop")?.status).toBe("completed");
    expect(run.usage).toEqual({ inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.001 });
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");
  });

  it("rejects a valid patch that exceeds the selected file scope", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-develop-scope-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
    await writeFile(join(workspace, "z-unselected.txt"), "outside scope\n", "utf8");
    await writeFile(join(workspace, "package.json"), '{"name":"scope-fixture"}\n', "utf8");
    await Promise.all(
      Array.from({ length: 11 }, (_value, index) =>
        writeFile(join(workspace, `a${String(index).padStart(2, "0")}.txt`), `${index}\n`, "utf8")
      )
    );
    await execFileAsync("git", ["add", "."], { cwd: workspace });

    const patch = [
      "diff --git a/z-unselected.txt b/z-unselected.txt",
      "--- a/z-unselected.txt",
      "+++ b/z-unselected.txt",
      "@@ -1 +1 @@",
      "-outside scope",
      "+new",
      ""
    ].join("\n");
    const provider = withPlanStage({
      async complete() {
        return {
          text: JSON.stringify({ summary: "Over-broad edit.", patch, decisions: [], openRisks: [] }),
          usage: { inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.001 }
        };
      }
    });
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(defaultConfig, store, {
      providers: new Map([["default", provider]])
    });

    const run = await orchestrator.run({
      request: "change hello.txt from old to new",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("FAILED");
    expect(run.stageRuns.find((stage) => stage.stage === "develop")?.result?.summary).toContain(
      "outside the selected context"
    );
    expect(await readFile(join(workspace, "z-unselected.txt"), "utf8")).toBe("outside scope\n");
  });
});
