import { posix } from "node:path";
import { z } from "zod";
import {
  lexicalTerms,
  refreshRepositoryIndex,
  RepositoryIndex,
  resolveRepositoryIndexPath,
  type IndexedFile
} from "../../context/repository-index.js";
import type { ActionDefinition } from "../types.js";

const TestSelectionInputSchema = z.object({
  changedFiles: z.array(z.string().min(1)).max(500).default([]),
  databasePath: z.string().min(1).default(".shadow/shadow.db"),
  exclusions: z.array(z.string().min(1)).max(200).default([]),
  maxSelectors: z.number().int().positive().max(100).default(20)
});

export const TestSelectionSchema = z.object({
  selectors: z.array(z.string()),
  changedFiles: z.array(z.string()),
  candidateCount: z.number().int().nonnegative(),
  strategy: z.enum(["targeted", "full_suite"])
});
export type TestSelection = z.infer<typeof TestSelectionSchema>;

export const testSelectionAction: ActionDefinition<
  z.infer<typeof TestSelectionInputSchema>,
  TestSelection
> = {
  manifest: {
    id: "tests.select",
    version: 1,
    description: "Map changed files to relevant test selectors using indexed paths and imports.",
    handler: "@shadow/actions/tests/select",
    inputSchema: "test_selection_input_v1",
    outputSchema: "test_selection_v1",
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
  input: TestSelectionInputSchema,
  output: TestSelectionSchema,
  async run(input, context) {
    const databasePath = resolveRepositoryIndexPath(context.workspaceRoot, input.databasePath);
    const refreshed = await refreshRepositoryIndex(context.workspaceRoot, databasePath, {
      exclusions: input.exclusions,
      execute: (command, options) => context.execute(command, options)
    });
    const changedFiles = input.changedFiles.filter(isSafeRepositoryPath);
    const index = new RepositoryIndex(databasePath, context.workspaceRoot);
    let candidates: IndexedFile[];
    try {
      candidates = index.listFiles().filter((file) => isTestPath(file.path));
    } finally {
      index.close();
    }

    const ranked = candidates
      .map((candidate) => ({
        path: candidate.path,
        score: changedFiles.reduce(
          (score, changed) => Math.max(score, testRelevance(candidate, changed)),
          0
        )
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const selectors = [...new Set(ranked.map((candidate) => candidate.path))]
      .slice(0, input.maxSelectors);
    const output: TestSelection = {
      selectors,
      changedFiles,
      candidateCount: candidates.length,
      strategy: selectors.length > 0 ? "targeted" : "full_suite"
    };
    return {
      summary: selectors.length > 0
        ? `Selected ${selectors.length} targeted tests for ${changedFiles.length} changed files.`
        : `No confident changed-file mapping found among ${candidates.length} tests; use the full suite.`,
      output,
      exitCode: 0,
      stdout: refreshed.stdout,
      stderr: refreshed.stderr
    };
  }
};

function isSafeRepositoryPath(path: string): boolean {
  return !path.startsWith("/") && !path.split(/[\\/]/).includes("..") && !path.startsWith(".shadow/");
}

function isTestPath(path: string): boolean {
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(path) ||
    /(?:^|[._-])(?:test|spec)\.[^.\/]+$/i.test(posix.basename(path));
}

function sourceStem(path: string): string {
  return posix.basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/(?:[._-](?:test|spec))$/i, "")
    .toLowerCase();
}

function testRelevance(test: IndexedFile, changedPath: string): number {
  if (test.path === changedPath) return 1_000;
  const changedStem = sourceStem(changedPath);
  const testStem = sourceStem(test.path);
  let score = changedStem === testStem ? 100 : 0;
  if (test.path.toLowerCase().includes(changedStem)) score += 30;
  if (posix.dirname(test.path) === posix.dirname(changedPath)) score += 20;
  const changedWithoutExtension = changedPath.replace(/\.[^.]+$/, "");
  for (const imported of test.imports) {
    const resolvedImport = imported.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(test.path), imported))
      : imported;
    if (
      sourceStem(imported) === changedStem ||
      resolvedImport === changedWithoutExtension ||
      resolvedImport.startsWith(`${changedWithoutExtension}.`)
    ) {
      score += 80;
      break;
    }
  }
  const changedTerms = new Set(lexicalTerms(changedPath));
  const overlap = lexicalTerms(`${test.path} ${test.symbols.join(" ")}`)
    .filter((term) => changedTerms.has(term)).length;
  return score + overlap * 5;
}
