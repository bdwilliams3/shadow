import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ActionDefinition, ActionHandlerContext, ProcessResult } from "../types.js";
import {
  ApplyPatchEnvelopeError,
  looksLikeApplyPatchEnvelope,
  translateApplyPatchEnvelope
} from "./apply-patch-envelope.js";

const PatchInputSchema = z.object({
  patch: z.string().min(1).max(500_000)
});

export const PatchResultSchema = z.object({
  valid: z.boolean(),
  applied: z.boolean(),
  changedFiles: z.array(z.string()),
  createdFiles: z.array(z.string()).default([]),
  diagnostics: z.string()
});
export type PatchResult = z.infer<typeof PatchResultSchema>;

function parseNumstat(value: string): string[] {
  const fields = value.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const columns = field.split("\t");
    const inlinePath = columns.slice(2).join("\t");
    if (inlinePath) {
      paths.push(inlinePath);
      continue;
    }
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    if (oldPath && newPath) {
      paths.push(newPath);
      index += 2;
    }
  }
  return [...new Set(paths)];
}

/**
 * Files Git itself reports the patch as creating. Taken from `git apply --summary`
 * rather than from a model claim, so a modification can never be passed off as a
 * new file to escape the bounded develop scope.
 */
/**
 * Why a patch carrying a destructive change was refused. Exported because scoring needs
 * to tell a refusal apart from an ordinary invalid patch: a system that refuses to delete
 * files has satisfied a safety criterion, and one whose patch merely failed to parse has
 * not. Both systems reach this guard through the same action.
 */
export const destructiveChangeRefusal =
  "File deletion, symlink changes, and binary patches require a separate approved action.";

const destructivePattern = /(?:delete mode|mode 120000|binary patch)/i;

function parseCreatedFiles(summary: string): string[] {
  const created: string[] = [];
  for (const line of summary.split("\n")) {
    const match = /^\s*create mode \d+ (.+)$/.exec(line);
    if (match?.[1]) {
      created.push(match[1].trim());
    }
  }
  return [...new Set(created)];
}

function safeChangedFiles(files: string[]): boolean {
  return files.every((path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."));
}

function failed(result: ProcessResult): boolean {
  return result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded;
}

interface PatchCheck {
  check: ProcessResult;
  numstat?: ProcessResult;
  changedFiles: string[];
  createdFiles: string[];
  /** True when Git had to derive the hunk line counts to read the patch at all. */
  recounted: boolean;
  /** True when the input was an `apply_patch` envelope translated to a unified diff. */
  translated: boolean;
  /** The diff Git actually saw. Differs from the input only when it was translated. */
  effectivePatch: string;
}

/** A refusal that never ran a command, shaped so the ordinary failure path can report it. */
function syntheticFailure(command: string[], message: string): ProcessResult {
  return { command, exitCode: 1, stdout: "", stderr: message, timedOut: false, outputLimitExceeded: false };
}

/**
 * Models routinely emit a hunk body whose context and edits are exactly right above an
 * `@@ -a,b +c,d @@` header whose counts are wrong; Git then rejects the entire patch as
 * corrupt. `--recount` derives the counts from the body instead of trusting the header.
 * Context lines must still match the file, so this repairs arithmetic, never intent, and
 * every Git invocation for one patch has to agree on the flag or apply would disagree
 * with check.
 */
function recountArgs(recounted: boolean): string[] {
  return recounted ? ["--recount"] : [];
}

async function checkPatch(
  rawPatch: string,
  context: ActionHandlerContext
): Promise<PatchCheck> {
  let patch = rawPatch;
  let translated = false;
  // Frontier models emit OpenAI's `*** Begin Patch` envelope in place of a unified diff
  // often enough to lose whole tasks on format alone. Translating before Git sees it
  // keeps every downstream guard — deletion, symlink, binary, scope — working on a diff.
  if (looksLikeApplyPatchEnvelope(rawPatch)) {
    try {
      // Git resolves patch paths against the cwd it runs in, so translation must read
      // the same files Git will write. The runner has already bounded cwd to the workspace.
      patch = (await translateApplyPatchEnvelope(rawPatch, context.cwd)).patch;
      translated = true;
    } catch (error) {
      if (!(error instanceof ApplyPatchEnvelopeError)) {
        throw error;
      }
      return {
        check: syntheticFailure(["apply-patch-envelope"], `${error.message}\n`),
        changedFiles: [],
        createdFiles: [],
        recounted: false,
        translated: false,
        effectivePatch: rawPatch
      };
    }
  }
  const checkCommand = (args: string[]): string[] => [
    "git",
    "apply",
    "--check",
    ...args,
    "--whitespace=error-all",
    "-"
  ];
  const strict = await context.execute(checkCommand([]), { stdin: patch });
  let check = strict;
  let recounted = false;
  if (failed(strict)) {
    const retried = await context.execute(checkCommand(["--recount"]), { stdin: patch });
    if (failed(retried)) {
      // Report the strict diagnostics: they describe the patch as the model wrote it.
      return {
        check: strict,
        changedFiles: [],
        createdFiles: [],
        recounted: false,
        translated,
        effectivePatch: patch
      };
    }
    check = retried;
    recounted = true;
  }
  const args = recountArgs(recounted);
  const numstatCommand = ["git", "apply", "--numstat", "-z", ...args, "-"];
  const numstat = await context.execute(numstatCommand, { stdin: patch });
  const changedFiles = failed(numstat) ? [] : parseNumstat(numstat.stdout);
  if (!safeChangedFiles(changedFiles)) {
    throw new Error("Patch contains a path outside the workspace.");
  }
  const summaryCommand = ["git", "apply", "--summary", ...args, "-"];
  const summary = await context.execute(summaryCommand, { stdin: patch });
  const forbiddenChange = destructivePattern.test(
    `${summary.stdout}\n${summary.stderr}\n${patch.includes("GIT binary patch") ? "binary patch" : ""}`
  );
  if (forbiddenChange) {
    return {
      check: { ...check, exitCode: 1, stderr: destructiveChangeRefusal },
      numstat,
      changedFiles,
      createdFiles: [],
      recounted,
      translated,
      effectivePatch: patch
    };
  }
  if (failed(summary)) {
    return { check: summary, numstat, changedFiles, createdFiles: [], recounted, translated, effectivePatch: patch };
  }
  return {
    check,
    numstat,
    changedFiles,
    createdFiles: parseCreatedFiles(summary.stdout),
    recounted,
    translated,
    effectivePatch: patch
  };
}

/** Describes any repair the actions had to perform, for the caller-visible summary. */
function repairNote(result: Pick<PatchCheck, "recounted" | "translated">): string {
  const repairs = [
    result.translated ? "an apply_patch envelope translated to a unified diff" : "",
    result.recounted ? "malformed hunk line counts recounted" : ""
  ].filter(Boolean);
  return repairs.length > 0 ? ` Repaired: ${repairs.join("; ")}.` : "";
}

export const patchCheckAction: ActionDefinition<z.infer<typeof PatchInputSchema>, PatchResult> = {
  manifest: {
    id: "patch.check",
    version: 1,
    description: "Validate a unified diff and summarize its affected paths without writing files.",
    handler: "@shadow/actions/patch/check",
    fallbackCommand: ["git", "apply", "--check", "--whitespace=error-all", "-"],
    inputSchema: "patch_input_v1",
    outputSchema: "patch_result_v1",
    risk: "read_only",
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
    network: false,
    writesWorkspace: false,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: true
  },
  input: PatchInputSchema,
  output: PatchResultSchema,
  async run(input, context) {
    const result = await checkPatch(input.patch, context);
    const valid = !failed(result.check) && result.numstat !== undefined && !failed(result.numstat);
    const diagnostics = [result.check.stderr, result.numstat?.stderr ?? ""].filter(Boolean).join("\n");
    return {
      summary: valid
        ? `Patch is valid and affects ${result.changedFiles.length} files.` + repairNote(result)
        : diagnostics.includes(destructiveChangeRefusal)
          ? `Patch refused: ${destructiveChangeRefusal}`
          : "Patch validation failed.",
      output: {
        valid,
        applied: false,
        changedFiles: result.changedFiles,
        createdFiles: result.createdFiles,
        diagnostics
      },
      exitCode: valid ? 0 : result.check.exitCode ?? 1,
      stdout: result.numstat?.stdout ?? result.check.stdout,
      stderr: diagnostics
    };
  }
};

export const patchApplyAction: ActionDefinition<z.infer<typeof PatchInputSchema>, PatchResult> = {
  manifest: {
    id: "patch.apply",
    version: 1,
    description: "Apply a previously generated unified diff inside the active workspace.",
    handler: "@shadow/actions/patch/apply",
    fallbackCommand: ["git", "apply", "--whitespace=error-all", "-"],
    inputSchema: "patch_input_v1",
    outputSchema: "patch_result_v1",
    risk: "workspace_write",
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
    network: false,
    writesWorkspace: true,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: false
  },
  input: PatchInputSchema,
  output: PatchResultSchema,
  async run(input, context) {
    const checked = await checkPatch(input.patch, context);
    if (failed(checked.check) || !checked.numstat || failed(checked.numstat)) {
      const diagnostics = [checked.check.stderr, checked.numstat?.stderr ?? ""].filter(Boolean).join("\n");
      return {
        summary: "Patch changed after validation or no longer applies cleanly.",
        output: {
          valid: false,
          applied: false,
          changedFiles: checked.changedFiles,
          createdFiles: checked.createdFiles,
          diagnostics
        },
        exitCode: checked.check.exitCode ?? 1,
        stderr: diagnostics
      };
    }
    const command = [
      "git",
      "apply",
      ...recountArgs(checked.recounted),
      "--whitespace=error-all",
      "-"
    ];
    const applied = await context.execute(command, { stdin: checked.effectivePatch });
    const success = !failed(applied);
    return {
      summary: success
        ? `Applied patch affecting ${checked.changedFiles.length} files.` + repairNote(checked)
        : "Patch application failed.",
      output: {
        valid: true,
        applied: success,
        changedFiles: checked.changedFiles,
        createdFiles: checked.createdFiles,
        diagnostics: applied.stderr
      },
      exitCode: success ? 0 : applied.exitCode ?? 1,
      stdout: applied.stdout,
      stderr: applied.stderr
    };
  }
};
