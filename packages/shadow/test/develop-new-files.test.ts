import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";
import type { PatchResult } from "../src/tools/actions/patch.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";

const execFileAsync = promisify(execFile);

function createPatch(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ""
  ].join("\n");
}

async function buildWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-new-file-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  await writeFile(join(workspace, "secret.txt"), "untouched\n", "utf8");
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "new-files", private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
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

function providerReturning(patch: string): ModelProvider {
  return {
    async complete() {
      return {
        text: JSON.stringify({ summary: "Added a file.", patch, decisions: [], openRisks: [] }),
        usage: { inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0 }
      };
    }
  };
}

async function runDevelop(workspace: string, provider: ModelProvider) {
  const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
  const orchestrator = new LifecycleOrchestrator(defaultConfig, store, {
    providers: new Map([["default", provider]])
  });
  const run = await orchestrator.run({
    request: "change hello.txt and add a notes file",
    workspaceRoot: workspace,
    dryRun: false
  });
  return { run, develop: run.stageRuns.find((stage) => stage.stage === "develop") };
}

describe("develop new-file creation", () => {
  it("applies a create-mode patch for a file absent from the selected context", async () => {
    const workspace = await buildWorkspace();
    const { run, develop } = await runDevelop(
      workspace,
      providerReturning(createPatch("notes.md", ["# Notes", "", "Added by Develop."]))
    );

    expect(develop?.status).toBe("completed");
    expect(develop?.result?.changedFiles).toContain("notes.md");
    expect(develop?.result?.decisions.join(" ")).toContain("Created 1 new files: notes.md");
    expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe(
      "# Notes\n\nAdded by Develop.\n"
    );
    expect(run.state).toBe("COMPLETED");
  });

  it("reports created files from Git, so a modification cannot pose as a creation", async () => {
    const workspace = await buildWorkspace();
    const actions = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const modification = [
      "diff --git a/secret.txt b/secret.txt",
      "--- a/secret.txt",
      "+++ b/secret.txt",
      "@@ -1 +1 @@",
      "-untouched",
      "+tampered",
      ""
    ].join("\n");

    const modified = await actions.run<PatchResult>("patch.check", { patch: modification }, {});
    expect(modified.output?.valid).toBe(true);
    expect(modified.output?.changedFiles).toEqual(["secret.txt"]);
    expect(modified.output?.createdFiles).toEqual([]);

    const created = await actions.run<PatchResult>(
      "patch.check",
      { patch: createPatch("notes.md", ["# Notes"]) },
      {}
    );
    expect(created.output?.createdFiles).toEqual(["notes.md"]);
    expect(created.output?.applied).toBe(false);
  });

  it("rejects a patch that creates more files than one bounded work unit allows", async () => {
    const workspace = await buildWorkspace();
    const patch = Array.from({ length: 11 }, (_value, index) =>
      createPatch(`generated/file-${index}.txt`, [`file ${index}`])
    ).join("");

    const { develop } = await runDevelop(workspace, providerReturning(patch));

    expect(develop?.status).toBe("failed");
    expect(develop?.result?.summary).toContain("above the bounded limit");
  });

  it("still refuses a patch that deletes a file", async () => {
    const workspace = await buildWorkspace();
    const patch = [
      "diff --git a/secret.txt b/secret.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/secret.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-untouched",
      ""
    ].join("\n");

    const { develop } = await runDevelop(workspace, providerReturning(patch));

    expect(develop?.status).toBe("failed");
    expect(await readFile(join(workspace, "secret.txt"), "utf8")).toBe("untouched\n");
  });
});
