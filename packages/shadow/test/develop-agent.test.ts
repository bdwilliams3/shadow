import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("enforces an explicit allowed changed-file scope", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-develop-allowed-scope-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
    await writeFile(join(workspace, "other.txt"), "outside scope\n", "utf8");
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8"
    );
    await execFileAsync("git", ["add", "."], { cwd: workspace });

    let modelFilePaths: string[] = [];
    const patch = [
      "diff --git a/other.txt b/other.txt",
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1 +1 @@",
      "-outside scope",
      "+new",
      ""
    ].join("\n");
    const provider = withPlanStage({
      async complete(request) {
        modelFilePaths = ((request.input as { files?: { path: string }[] }).files ?? [])
          .map((file) => file.path);
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
      dryRun: false,
      allowedChangedFiles: ["hello.txt"]
    });

    expect(run.state).toBe("FAILED");
    expect(modelFilePaths).toEqual(["hello.txt"]);
    expect(run.stageRuns.find((stage) => stage.stage === "develop")?.result?.summary).toContain(
      "outside the allowed change scope"
    );
    expect(await readFile(join(workspace, "other.txt"), "utf8")).toBe("outside scope\n");
  });

  it("keeps Develop model context below the broad action default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-develop-context-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await mkdir(join(workspace, "core/connectors"), { recursive: true });
    await writeFile(
      join(workspace, "core/config.py"),
      "from dataclasses import dataclass\n\n@dataclass(frozen=True)\nclass ProviderCreds:\n    extra: dict[str, str]\n",
      "utf8"
    );
    await writeFile(
      join(workspace, "core/connectors/cloudflare.py"),
      "from ..config import ProviderCreds\n\nclass CloudflareConnector:\n    pass\n",
      "utf8"
    );
    await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        writeFile(join(workspace, `noise-${index}.md`), "connector request timeout ".repeat(300), "utf8")
      )
    );
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8"
    );
    await execFileAsync("git", ["add", "."], { cwd: workspace });

    let developFileCount = 0;
    const patch = [
      "diff --git a/core/config.py b/core/config.py",
      "--- a/core/config.py",
      "+++ b/core/config.py",
      "@@ -1,4 +1,5 @@",
      " from dataclasses import dataclass",
      "+DEFAULT_REQUEST_TIMEOUT = 30",
      " ",
      " @dataclass(frozen=True)",
      " class ProviderCreds:",
      ""
    ].join("\n");
    const provider = withPlanStage({
      async complete(request) {
        developFileCount = Array.isArray((request.input as { files?: unknown[] }).files)
          ? (request.input as { files: unknown[] }).files.length
          : developFileCount;
        return {
          text: JSON.stringify({
            summary: "Added a central default timeout.",
            patch,
            decisions: [],
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
      request: "Give connector configuration an explicit request timeout with a default.",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("COMPLETED");
    expect(developFileCount).toBeLessThanOrEqual(4);
    expect(await readFile(join(workspace, "core/config.py"), "utf8")).toContain("DEFAULT_REQUEST_TIMEOUT = 30");
  });
});
