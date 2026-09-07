import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import {
  ApplyPatchEnvelopeError,
  looksLikeApplyPatchFragment,
  looksLikeApplyPatchEnvelope,
  translateApplyPatchEnvelope
} from "../src/tools/actions/apply-patch-envelope.js";
import type { PatchResult } from "../src/tools/actions/patch.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";

const execFileAsync = promisify(execFile);

/** The python-cli fixture as `benchmark run` provisions it. */
const fixtureSource = [
  "import argparse",
  "",
  "",
  'def greeting(name: str = "world") -> str:',
  '    return f"hello {name}"',
  "",
  "",
  "def main() -> None:",
  "    parser = argparse.ArgumentParser()",
  "    parser.parse_args()",
  "    print(greeting())",
  "",
  "",
  'if __name__ == "__main__":',
  "    main()",
  ""
].join("\n");

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-envelope-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(workspace, path), content, "utf8");
  }
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
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

// Recorded verbatim from the baseline artifact of benchmark run 4, where this envelope
// cost python-cli-v1/greeting-option a task that the edit itself would have passed.
const recordedEnvelope = [
  "*** Begin Patch",
  "*** Update File: shadow_fixture.py",
  "@@",
  " def main() -> None:",
  "     parser = argparse.ArgumentParser()",
  "-    parser.parse_args()",
  "-    print(greeting())",
  '+    parser.add_argument("--name", default="world")',
  "+    args = parser.parse_args()",
  "+    print(greeting(args.name))",
  "*** End Patch",
  ""
].join("\n");

describe("apply_patch envelope translation", () => {
  it("recognizes an envelope without mistaking a unified diff for one", () => {
    expect(looksLikeApplyPatchEnvelope(recordedEnvelope)).toBe(true);
    expect(
      looksLikeApplyPatchEnvelope(
        ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n")
      )
    ).toBe(false);
    expect(looksLikeApplyPatchFragment(recordedEnvelope)).toBe(false);
    expect(looksLikeApplyPatchFragment("*** Update File: shadow_fixture.py\n@@\n-old\n+new\n"))
      .toBe(true);
  });

  it("extracts a loose apply_patch fragment after malformed diff preamble", async () => {
    const workspace = await workspaceWith({ "shadow_fixture.py": fixtureSource });
    const looseFragment = [
      "diff --git a/ignored.py b/ignored.py",
      "@@ -1 +1 @@",
      "```yaml",
      "*** Update File: shadow_fixture.py",
      "@@",
      " def main() -> None:",
      "     parser = argparse.ArgumentParser()",
      "-    parser.parse_args()",
      "-    print(greeting())",
      '+    parser.add_argument("--name", default="world")',
      "+    args = parser.parse_args()",
      "+    print(greeting(args.name))",
      "*** End Patch",
      ""
    ].join("\n");

    const checked = await runner(workspace).run<PatchResult>("patch.check", {
      patch: looseFragment
    });
    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: looseFragment },
      { allowWorkspaceWrites: true }
    );

    expect(checked.output).toMatchObject({ valid: true, changedFiles: ["shadow_fixture.py"] });
    expect(checked.record.summary).toContain("apply_patch envelope");
    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "shadow_fixture.py"), "utf8")).toContain(
      "print(greeting(args.name))"
    );
  });

  it("applies the envelope that lost greeting-option in run 4", async () => {
    const workspace = await workspaceWith({ "shadow_fixture.py": fixtureSource });

    const checked = await runner(workspace).run<PatchResult>("patch.check", {
      patch: recordedEnvelope
    });
    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: recordedEnvelope },
      { allowWorkspaceWrites: true }
    );

    expect(checked.output).toMatchObject({ valid: true, changedFiles: ["shadow_fixture.py"] });
    expect(checked.record.summary).toContain("apply_patch envelope");
    expect(applied.output?.applied).toBe(true);

    const updated = await readFile(join(workspace, "shadow_fixture.py"), "utf8");
    expect(updated).toContain('parser.add_argument("--name", default="world")');
    expect(updated).toContain("print(greeting(args.name))");
    expect(updated).not.toContain("print(greeting())");
    // Everything outside the hunk has to survive untouched.
    expect(updated.startsWith("import argparse\n")).toBe(true);
    expect(updated.endsWith('if __name__ == "__main__":\n    main()\n')).toBe(true);
  });

  it("creates a file from an Add File section", async () => {
    const workspace = await workspaceWith({ "keep.txt": "keep\n" });
    const envelope = [
      "*** Begin Patch",
      "*** Add File: notes/new.txt",
      "+first",
      "+second",
      "*** End Patch",
      ""
    ].join("\n");
    await execFileAsync("mkdir", ["-p", join(workspace, "notes")]);

    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: envelope },
      { allowWorkspaceWrites: true }
    );

    expect(applied.output?.applied).toBe(true);
    expect(applied.output?.createdFiles).toEqual(["notes/new.txt"]);
    expect(await readFile(join(workspace, "notes/new.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("still refuses a deletion expressed as an envelope", async () => {
    const workspace = await workspaceWith({ "gone.txt": "one\ntwo\n" });
    const envelope = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch", ""].join("\n");

    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: envelope });

    expect(result.output?.valid).toBe(false);
    expect(result.output?.diagnostics).toContain("require a separate approved action");
    expect(await readFile(join(workspace, "gone.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("reports an actionable reason instead of guessing at an ambiguous hunk", async () => {
    const workspace = await workspaceWith({ "dup.txt": "x\nsame\nx\nsame\nx\n" });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: dup.txt",
      "@@",
      "-same",
      "+changed",
      "*** End Patch",
      ""
    ].join("\n");

    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: envelope });

    expect(result.output?.valid).toBe(false);
    expect(result.output?.diagnostics).toContain("matches 2 locations");
    expect(await readFile(join(workspace, "dup.txt"), "utf8")).toBe("x\nsame\nx\nsame\nx\n");
  });

  it("refuses a rename rather than expressing it as a delete and an add", async () => {
    const workspace = await workspaceWith({ "old.txt": "content\n" });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
      ""
    ].join("\n");

    await expect(translateApplyPatchEnvelope(envelope, workspace)).rejects.toThrow(
      ApplyPatchEnvelopeError
    );
    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: envelope });
    expect(result.output?.diagnostics).toContain("Renames require a separate approved action");
  });

  it("keeps a file that ends without a newline intact", async () => {
    const workspace = await workspaceWith({ "tail.txt": "alpha\nomega" });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: tail.txt",
      "@@",
      " alpha",
      "-omega",
      "+zulu",
      "*** End Patch",
      ""
    ].join("\n");

    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: envelope },
      { allowWorkspaceWrites: true }
    );

    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "tail.txt"), "utf8")).toBe("alpha\nzulu");
  });

  it("places multiple hunks in one file independently", async () => {
    const workspace = await workspaceWith({
      "multi.txt": ["one", "two", "three", "four", "five", "six"].join("\n") + "\n"
    });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: multi.txt",
      "@@",
      " one",
      "-two",
      "+TWO",
      "@@",
      " five",
      "-six",
      "+SIX",
      "*** End Patch",
      ""
    ].join("\n");

    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: envelope },
      { allowWorkspaceWrites: true }
    );

    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "multi.txt"), "utf8")).toBe(
      ["one", "TWO", "three", "four", "five", "SIX"].join("\n") + "\n"
    );
  });

  it("places out-of-order hunks by file position before emitting a diff", async () => {
    const workspace = await workspaceWith({
      "multi.txt": ["one", "two", "three", "four", "five", "six"].join("\n") + "\n"
    });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: multi.txt",
      "@@",
      " five",
      "-six",
      "+SIX",
      "@@",
      " one",
      "-two",
      "+TWO",
      "*** End Patch",
      ""
    ].join("\n");

    const applied = await runner(workspace).run<PatchResult>(
      "patch.apply",
      { patch: envelope },
      { allowWorkspaceWrites: true }
    );

    expect(applied.output?.applied).toBe(true);
    expect(await readFile(join(workspace, "multi.txt"), "utf8")).toBe(
      ["one", "TWO", "three", "four", "five", "SIX"].join("\n") + "\n"
    );
  });

  it("reports a file the envelope updates but the workspace does not have", async () => {
    const workspace = await workspaceWith({ "present.txt": "here\n" });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: absent.txt",
      "@@",
      "-nothing",
      "+something",
      "*** End Patch",
      ""
    ].join("\n");

    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: envelope });

    expect(result.output?.valid).toBe(false);
    expect(result.output?.diagnostics).toContain("not in the workspace");
  });

  it("refuses an envelope that escapes the workspace", async () => {
    const workspace = await workspaceWith({ "present.txt": "here\n" });
    const envelope = [
      "*** Begin Patch",
      "*** Update File: ../escape.txt",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
      ""
    ].join("\n");

    const result = await runner(workspace).run<PatchResult>("patch.check", { patch: envelope });

    expect(result.output?.valid).toBe(false);
    expect(result.output?.diagnostics).toContain("outside the workspace");
  });
});
