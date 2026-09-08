import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { PatchResult } from "../src/tools/actions/patch.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";

const execFileAsync = promisify(execFile);

async function gitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-patch-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, "hello.txt"), "old\n", "utf8");
  await execFileAsync("git", ["add", "hello.txt"], { cwd: workspace });
  return workspace;
}

function runner(workspace: string): ActionRunner {
  return new ActionRunner(
    createDefaultActionRegistry(),
    workspace,
    defaultConfig,
    new ArtifactStore(join(workspace, ".shadow/artifacts"))
  );
}

const updatePatch = [
  "diff --git a/hello.txt b/hello.txt",
  "--- a/hello.txt",
  "+++ b/hello.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  ""
].join("\n");

describe("patch actions", () => {
  it("checks before applying and enforces stage write permission", async () => {
    const workspace = await gitWorkspace();
    const actions = runner(workspace);

    const checked = await actions.run<PatchResult>("patch.check", { patch: updatePatch });
    const blocked = await actions.run<PatchResult>("patch.apply", { patch: updatePatch });
    const preview = await actions.run<PatchResult>(
      "patch.apply",
      { patch: updatePatch },
      { dryRun: true }
    );
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("old\n");
    const applied = await actions.run<PatchResult>(
      "patch.apply",
      { patch: updatePatch },
      { allowWorkspaceWrites: true }
    );

    expect(checked.output).toMatchObject({ valid: true, applied: false, changedFiles: ["hello.txt"] });
    expect(blocked.record.status).toBe("blocked");
    expect(preview.record.status).toBe("skipped");
    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");
  });

  it("applies a patch whose hunk header miscounts its body", async () => {
    const workspace = await gitWorkspace();
    const actions = runner(workspace);
    // A body Git can apply under a header claiming three original lines where the
    // hunk supplies one. Models produce this constantly and Git calls it corrupt.
    const miscounted = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      "-old",
      "+new",
      ""
    ].join("\n");

    const checked = await actions.run<PatchResult>("patch.check", { patch: miscounted });
    const applied = await actions.run<PatchResult>(
      "patch.apply",
      { patch: miscounted },
      { allowWorkspaceWrites: true }
    );

    expect(checked.output).toMatchObject({ valid: true, changedFiles: ["hello.txt"] });
    expect(checked.record.summary).toContain("recounted");
    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");
  });

  it("applies a unified diff with stray apply_patch markers", async () => {
    const workspace = await gitWorkspace();
    const hybrid = [
      "*** Begin Patch",
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "*** End Patch"
    ].join("\n");

    const checked = await runner(workspace).run<PatchResult>("patch.check", { patch: hybrid });
    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: hybrid },
      { allowWorkspaceWrites: true }
    );

    expect(checked.output).toMatchObject({ valid: true, changedFiles: ["hello.txt"] });
    expect(checked.record.summary).toContain("stray apply_patch markers removed");
    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("new\n");
  });

  it("reports the strict diagnostics when recounting cannot save the patch", async () => {
    const workspace = await gitWorkspace();
    const unmatched = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      "-absent",
      "+new",
      ""
    ].join("\n");

    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: unmatched });

    expect(result.output?.valid).toBe(false);
    expect(result.output?.diagnostics).toContain("corrupt patch");
  });

  it("rejects file deletion through the ordinary patch action", async () => {
    const workspace = await gitWorkspace();
    const deletion = [
      "diff --git a/hello.txt b/hello.txt",
      "deleted file mode 100644",
      "--- a/hello.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      ""
    ].join("\n");

    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: deletion });

    expect(result.record.status).toBe("failed");
    expect(result.output?.valid).toBe(false);
    expect(result.output?.diagnostics).toContain("require a separate approved action");
  });
});
