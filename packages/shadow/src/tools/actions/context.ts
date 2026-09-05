import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  lexicalTerms,
  refreshRepositoryIndex,
  RepositoryIndex,
  resolveRepositoryIndexPath
} from "../../context/repository-index.js";
import type { ActionDefinition } from "../types.js";

const ContextSelectInputSchema = z.object({
  request: z.string().min(1),
  candidatePaths: z.array(z.string().min(1)).max(100).default([]),
  maxFiles: z.number().int().positive().max(30).default(10),
  maxBytes: z.number().int().positive().max(500_000).default(80_000),
  databasePath: z.string().min(1).default(".shadow/shadow.db"),
  exclusions: z.array(z.string().min(1)).max(200).default([])
});

const SelectedFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean(),
  redacted: z.boolean()
});

export const SelectedContextSchema = z.object({
  files: z.array(SelectedFileSchema),
  totalBytes: z.number().int().nonnegative(),
  omittedFiles: z.number().int().nonnegative(),
  selectionTerms: z.array(z.string()),
  redactionCount: z.number().int().nonnegative()
});
export type SelectedContext = z.infer<typeof SelectedContextSchema>;

const ContextVerifyInputSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().length(64)
    })
  ).min(1).max(30)
});

export const ContextVerificationSchema = z.object({
  valid: z.boolean(),
  mismatches: z.array(z.object({ path: z.string(), reason: z.string() }))
});
export type ContextVerification = z.infer<typeof ContextVerificationSchema>;

function isSafeRelativePath(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

function redactSecrets(value: string): { content: string; redactions: number } {
  let redactions = 0;
  const replace = (pattern: RegExp, replacement: string): void => {
    value = value.replace(pattern, (_match: string, ...args: unknown[]) => {
      redactions += 1;
      return replacement.replace("$1", String(args[0] ?? ""));
    });
  };

  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]");
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
  replace(
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi,
    "$1=[REDACTED]"
  );
  return { content: value, redactions };
}

export const contextSelectAction: ActionDefinition<
  z.infer<typeof ContextSelectInputSchema>,
  SelectedContext
> = {
  manifest: {
    id: "context.select",
    version: 2,
    description: "Refresh the repository index and load a bounded FTS-ranked context for one model call.",
    handler: "@shadow/actions/context/select",
    inputSchema: "context_select_input_v2",
    outputSchema: "selected_context_v1",
    risk: "read_only",
    timeoutMs: 30_000,
    maxOutputBytes: 2_000_000,
    network: false,
    writesWorkspace: false,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: true
  },
  input: ContextSelectInputSchema,
  output: SelectedContextSchema,
  async run(input, context) {
    const databasePath = resolveRepositoryIndexPath(context.workspaceRoot, input.databasePath);
    const refreshed = await refreshRepositoryIndex(context.workspaceRoot, databasePath, {
      exclusions: input.exclusions,
      execute: (command, options) => context.execute(command, options)
    });
    const terms = lexicalTerms(input.request);
    const index = new RepositoryIndex(databasePath, context.workspaceRoot);
    const rankedByPath = new Map<string, { path: string; score: number }>();
    try {
      for (const path of input.candidatePaths.filter(isSafeRelativePath)) {
        if (index.getFile(path)) rankedByPath.set(path, { path, score: 1_000 });
      }
      for (const file of index.search(input.request, Math.max(100, input.maxFiles * 5))) {
        if (!rankedByPath.has(file.path)) rankedByPath.set(file.path, { path: file.path, score: file.score });
      }
      if (rankedByPath.size < input.maxFiles) {
        for (const file of index.listFiles()) {
          if (!rankedByPath.has(file.path)) rankedByPath.set(file.path, { path: file.path, score: 0 });
        }
      }
    } finally {
      index.close();
    }
    const ranked = [...rankedByPath.values()]
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    const files: SelectedContext["files"] = [];
    let totalBytes = 0;
    let redactionCount = 0;
    for (const candidate of ranked) {
      if (files.length >= input.maxFiles || totalBytes >= input.maxBytes) {
        break;
      }
      const path = resolve(context.workspaceRoot, candidate.path);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        continue;
      }
      const canonical = await realpath(path);
      const relativeCanonical = relative(context.workspaceRoot, canonical);
      if (relativeCanonical === ".." || relativeCanonical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        continue;
      }
      const content = await readFile(canonical);
      if (content.includes(0)) {
        continue;
      }
      const remaining = input.maxBytes - totalBytes;
      const selected = content.subarray(0, remaining);
      const redacted = redactSecrets(selected.toString("utf8"));
      redactionCount += redacted.redactions;
      files.push({
        path: candidate.path,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        content: redacted.content,
        truncated: selected.byteLength < content.byteLength,
        redacted: redacted.redactions > 0
      });
      totalBytes += selected.byteLength;
    }

    const output = {
      files,
      totalBytes,
      omittedFiles: Math.max(0, ranked.length - files.length),
      selectionTerms: terms,
      redactionCount
    };
    return {
      summary: `Selected ${files.length} files (${totalBytes} bytes) from ${ranked.length} text candidates.`,
      output,
      exitCode: 0,
      stdout: refreshed.stdout,
      stderr: refreshed.stderr
    };
  }
};

export const contextVerifyAction: ActionDefinition<
  z.infer<typeof ContextVerifyInputSchema>,
  ContextVerification
> = {
  manifest: {
    id: "context.verify",
    version: 1,
    description: "Verify selected file hashes before applying a model-produced patch.",
    handler: "@shadow/actions/context/verify",
    inputSchema: "context_verify_input_v1",
    outputSchema: "context_verification_v1",
    risk: "read_only",
    timeoutMs: 30_000,
    maxOutputBytes: 200_000,
    network: false,
    writesWorkspace: false,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: true
  },
  input: ContextVerifyInputSchema,
  output: ContextVerificationSchema,
  async run(input, context) {
    const mismatches: ContextVerification["mismatches"] = [];
    for (const expected of input.files) {
      if (!isSafeRelativePath(expected.path)) {
        mismatches.push({ path: expected.path, reason: "path is outside the workspace" });
        continue;
      }
      const path = resolve(context.workspaceRoot, expected.path);
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          mismatches.push({ path: expected.path, reason: "path is no longer a regular file" });
          continue;
        }
        const canonical = await realpath(path);
        const relativeCanonical = relative(context.workspaceRoot, canonical);
        if (relativeCanonical === ".." || relativeCanonical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
          mismatches.push({ path: expected.path, reason: "path now resolves outside the workspace" });
          continue;
        }
        const actual = createHash("sha256").update(await readFile(canonical)).digest("hex");
        if (actual !== expected.sha256) {
          mismatches.push({ path: expected.path, reason: "content changed after context selection" });
        }
      } catch {
        mismatches.push({ path: expected.path, reason: "file is missing or unreadable" });
      }
    }
    return {
      summary: mismatches.length === 0
        ? `Verified ${input.files.length} selected file hashes.`
        : `${mismatches.length} selected files changed after context selection.`,
      output: { valid: mismatches.length === 0, mismatches },
      exitCode: mismatches.length === 0 ? 0 : 1
    };
  }
};
