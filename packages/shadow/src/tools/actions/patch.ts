import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ActionDefinition, ActionHandlerContext, ProcessResult } from "../types.js";

const PatchInputSchema = z.object({
  patch: z.string().min(1).max(500_000)
});

export const PatchResultSchema = z.object({
  valid: z.boolean(),
  applied: z.boolean(),
  changedFiles: z.array(z.string()),
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

function safeChangedFiles(files: string[]): boolean {
  return files.every((path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."));
}

function failed(result: ProcessResult): boolean {
  return result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded;
}

async function checkPatch(
  patch: string,
  context: ActionHandlerContext
): Promise<{ check: ProcessResult; numstat?: ProcessResult; changedFiles: string[] }> {
  const checkCommand = ["git", "apply", "--check", "--whitespace=error-all", "-"];
  const check = await context.execute(checkCommand, { stdin: patch });
  if (failed(check)) {
    return { check, changedFiles: [] };
  }
  const numstatCommand = ["git", "apply", "--numstat", "-z", "-"];
  const numstat = await context.execute(numstatCommand, { stdin: patch });
  const changedFiles = failed(numstat) ? [] : parseNumstat(numstat.stdout);
  if (!safeChangedFiles(changedFiles)) {
    throw new Error("Patch contains a path outside the workspace.");
  }
  const summaryCommand = ["git", "apply", "--summary", "-"];
  const summary = await context.execute(summaryCommand, { stdin: patch });
  const forbiddenChange = /(?:delete mode|mode 120000|binary patch)/i.test(
    `${summary.stdout}\n${summary.stderr}\n${patch.includes("GIT binary patch") ? "binary patch" : ""}`
  );
  if (forbiddenChange) {
    return {
      check: { ...check, exitCode: 1, stderr: "File deletion, symlink changes, and binary patches require a separate approved action." },
      numstat,
      changedFiles
    };
  }
  if (failed(summary)) {
    return { check: summary, numstat, changedFiles };
  }
  return { check, numstat, changedFiles };
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
        ? `Patch is valid and affects ${result.changedFiles.length} files.`
        : "Patch validation failed.",
      output: { valid, applied: false, changedFiles: result.changedFiles, diagnostics },
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
        output: { valid: false, applied: false, changedFiles: checked.changedFiles, diagnostics },
        exitCode: checked.check.exitCode ?? 1,
        stderr: diagnostics
      };
    }
    const command = ["git", "apply", "--whitespace=error-all", "-"];
    const applied = await context.execute(command, { stdin: input.patch });
    const success = !failed(applied);
    return {
      summary: success
        ? `Applied patch affecting ${checked.changedFiles.length} files.`
        : "Patch application failed.",
      output: {
        valid: true,
        applied: success,
        changedFiles: checked.changedFiles,
        diagnostics: applied.stderr
      },
      exitCode: success ? 0 : applied.exitCode ?? 1,
      stdout: applied.stdout,
      stderr: applied.stderr
    };
  }
};
