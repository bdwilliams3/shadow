import { z } from "zod";
import {
  refreshRepositoryIndex,
  resolveRepositoryIndexPath
} from "../../context/repository-index.js";
import type { ActionDefinition } from "../types.js";

const RepositoryInspectInputSchema = z.object({
  maxFiles: z.number().int().positive().max(20_000).default(5_000),
  databasePath: z.string().min(1).default(".shadow/shadow.db"),
  exclusions: z.array(z.string().min(1)).max(200).default([])
});

export const RepositoryInventorySchema = z.object({
  fileCount: z.number().int().nonnegative(),
  indexedFileCount: z.number().int().nonnegative(),
  updatedFiles: z.number().int().nonnegative(),
  removedFiles: z.number().int().nonnegative(),
  unchangedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  source: z.enum(["git", "filesystem"]),
  languages: z.record(z.string(), z.number().int().nonnegative()),
  manifests: z.array(z.string()),
  sampleFiles: z.array(z.string())
});
export type RepositoryInventory = z.infer<typeof RepositoryInventorySchema>;

export const repositoryInspectAction: ActionDefinition<
  z.infer<typeof RepositoryInspectInputSchema>,
  RepositoryInventory
> = {
  manifest: {
    id: "repository.inspect",
    version: 2,
    description: "Inventory repository files and incrementally refresh the lexical repository index.",
    handler: "@shadow/actions/repository/inspect",
    fallbackCommand: ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    inputSchema: "repository_inspect_input_v2",
    outputSchema: "repository_inventory_v2",
    risk: "read_only",
    timeoutMs: 60_000,
    maxOutputBytes: 2_000_000,
    network: false,
    writesWorkspace: false,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: true
  },
  input: RepositoryInspectInputSchema,
  output: RepositoryInventorySchema,
  async run(input, context) {
    const databasePath = resolveRepositoryIndexPath(context.workspaceRoot, input.databasePath);
    const summary = await refreshRepositoryIndex(context.workspaceRoot, databasePath, {
      maxFiles: input.maxFiles,
      exclusions: input.exclusions,
      execute: (command, options) => context.execute(command, options)
    });
    const output: RepositoryInventory = {
      fileCount: summary.fileCount,
      indexedFileCount: summary.indexedFileCount,
      updatedFiles: summary.updatedFiles,
      removedFiles: summary.removedFiles,
      unchangedFiles: summary.unchangedFiles,
      truncated: summary.truncated,
      source: summary.source,
      languages: summary.languages,
      manifests: summary.manifests,
      sampleFiles: summary.sampleFiles
    };
    return {
      summary: `Inspected ${output.fileCount} files; indexed ${output.indexedFileCount} text files (${output.updatedFiles} updated, ${output.removedFiles} removed).`,
      output,
      exitCode: 0,
      stdout: summary.stdout,
      stderr: summary.stderr
    };
  }
};
