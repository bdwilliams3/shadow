import { z } from "zod";

export const AcceptanceAssertionSchema = z.enum([
  "no_unapproved_risky_action",
  "changed_files_within_relevant",
  "destructive_action_refused"
]);
export type AcceptanceAssertion = z.infer<typeof AcceptanceAssertionSchema>;

export const AcceptanceCheckSchema = z.object({
  id: z.string().min(1),
  criterion: z.number().int().nonnegative(),
  command: z.array(z.string().min(1)).min(1).optional(),
  expectExitCode: z.number().int().default(0),
  expectStdoutContains: z.array(z.string().min(1)).default([]),
  expectStdoutExcludes: z.array(z.string().min(1)).default([]),
  timeoutSeconds: z.number().int().positive().max(600).default(120),
  assert: AcceptanceAssertionSchema.optional()
}).superRefine((check, context) => {
  if ((check.command === undefined) === (check.assert === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["command"],
      message: "a check must declare exactly one of command or assert"
    });
  }
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const BenchmarkTaskSchema = z.object({
  id: z.string().min(1),
  request: z.string().min(1),
  relevantFiles: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  acceptanceChecks: z.array(AcceptanceCheckSchema).default([]),
  dangerousOperations: z.array(z.string().min(1)).default([]),
  permittedSideEffects: z.array(z.enum(["none", "workspace_write", "network", "external_write"])).min(1),
  expectedEvidence: z.array(z.string().min(1)).min(1),
  safetyAssertions: z.array(z.string().min(1)).min(1)
}).superRefine((task, context) => {
  const seen = new Set<string>();
  for (const [index, check] of task.acceptanceChecks.entries()) {
    if (check.criterion >= task.acceptanceCriteria.length) {
      context.addIssue({
        code: "custom",
        path: ["acceptanceChecks", index, "criterion"],
        message: `criterion ${check.criterion} is outside the ${task.acceptanceCriteria.length} declared criteria`
      });
    }
    if (seen.has(check.id)) {
      context.addIssue({
        code: "custom",
        path: ["acceptanceChecks", index, "id"],
        message: `duplicate check id ${check.id}`
      });
    }
    seen.add(check.id);
  }
});
export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;

/**
 * Where a fixture's starting tree comes from.
 *
 * `source` is a Git repository — a local path or a clone URL — and `revision` is anything
 * `git rev-parse` accepts, though a full SHA is what makes a result reproducible. The
 * repository is cloned into the workspace and checked out at that revision, so a fixture
 * costs a few lines of YAML no matter how large the repository is.
 *
 * This exists because the alternative does not scale: a harness meant to run against any
 * repository cannot require a committed copy of every repository it is evaluated on. Git
 * is already a content-addressed store of exactly the thing a fixture needs, and a commit
 * SHA is stronger provenance than a hand-maintained revision integer.
 */
export const GitRepositorySourceSchema = z.object({
  source: z.string().min(1),
  revision: z.string().min(1),
  /** Paths to drop after checkout: vendored trees, build output, large binaries. */
  exclude: z.array(z.string().min(1)).default([])
});
export type GitRepositorySource = z.infer<typeof GitRepositorySourceSchema>;

export const BenchmarkFixtureSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  description: z.string().min(1),
  /**
   * Either a directory beside the fixture whose contents are the starting tree, or a Git
   * source. The directory form suits small hand-authored trees that have no upstream; the
   * Git form suits real repositories, which should never be copied in.
   */
  repository: z.union([z.string().min(1), GitRepositorySourceSchema]),
  /** Required only for the directory form, where nothing else identifies the contents. */
  repositoryRevision: z.number().int().positive().optional(),
  tasks: z.array(BenchmarkTaskSchema).min(1)
}).superRefine((fixture, context) => {
  if (typeof fixture.repository === "string" && fixture.repositoryRevision === undefined) {
    context.addIssue({
      code: "custom",
      path: ["repositoryRevision"],
      message: "a directory repository must declare repositoryRevision"
    });
  }
});
export type BenchmarkFixture = z.infer<typeof BenchmarkFixtureSchema>;

/** Criteria that carry at least one deterministic check can be scored; the rest cannot. */
export function evaluableCriteria(task: BenchmarkTask): Set<number> {
  return new Set(task.acceptanceChecks.map((check) => check.criterion));
}
