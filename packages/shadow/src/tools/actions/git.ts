import { z } from "zod";
import type { ActionDefinition, ProcessResult } from "../types.js";

const GitStatusInputSchema = z.object({});

export const GitStatusSummarySchema = z.object({
  repository: z.boolean(),
  clean: z.boolean(),
  changedFiles: z.array(z.string()),
  entries: z.array(
    z.object({
      status: z.string().length(2),
      path: z.string().min(1),
      originalPath: z.string().min(1).optional()
    })
  )
});
export type GitStatusSummary = z.infer<typeof GitStatusSummarySchema>;

function parseStatus(result: ProcessResult): GitStatusSummary {
  if (result.timedOut) {
    throw new Error("Git status timed out");
  }
  if (result.outputLimitExceeded) {
    throw new Error("Git status exceeded the action output limit");
  }
  if (result.exitCode !== 0) {
    return { repository: false, clean: true, changedFiles: [], entries: [] };
  }

  const fields = result.stdout.split("\0").filter(Boolean);
  const entries: GitStatusSummary["entries"] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const originalPath = fields[index + 1];
      if (originalPath) {
        if (!isShadowRuntimePath(path) && !isShadowRuntimePath(originalPath)) {
          entries.push({ status, path, originalPath });
        }
        index += 1;
        continue;
      }
    }
    if (!isShadowRuntimePath(path)) {
      entries.push({ status, path });
    }
  }

  return {
    repository: true,
    clean: entries.length === 0,
    changedFiles: [...new Set(entries.map((entry) => entry.path))],
    entries
  };
}

function isShadowRuntimePath(path: string): boolean {
  return path.startsWith(".shadow/artifacts/") ||
    path.startsWith(".shadow/runs/") ||
    path.startsWith(".shadow/test-runs/") ||
    path === ".shadow/shadow.db" ||
    path === ".shadow/shadow.db-shm" ||
    path === ".shadow/shadow.db-wal";
}

export const gitStatusAction: ActionDefinition<z.infer<typeof GitStatusInputSchema>, GitStatusSummary> = {
  manifest: {
    id: "git.status",
    version: 1,
    description: "Summarize tracked and untracked workspace changes.",
    fallbackCommand: ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    inputSchema: "empty_object_v1",
    outputSchema: "git_status_summary_v1",
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
  input: GitStatusInputSchema,
  output: GitStatusSummarySchema,
  async run(_input, context) {
    const command = ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"];
    const result = await context.execute(command);
    const output = parseStatus(result);
    return {
      summary: output.repository
        ? output.clean
          ? "Git workspace is clean."
          : `Git workspace has ${output.changedFiles.length} changed files.`
        : "Workspace is not a Git repository.",
      output,
      commands: [command],
      exitCode: output.repository ? 0 : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
};
