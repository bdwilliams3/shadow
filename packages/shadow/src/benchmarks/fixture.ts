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

export const BenchmarkFixtureSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  description: z.string().min(1),
  repository: z.string().min(1),
  repositoryRevision: z.number().int().positive(),
  tasks: z.array(BenchmarkTaskSchema).min(1)
});
export type BenchmarkFixture = z.infer<typeof BenchmarkFixtureSchema>;

/** Criteria that carry at least one deterministic check can be scored; the rest cannot. */
export function evaluableCriteria(task: BenchmarkTask): Set<number> {
  return new Set(task.acceptanceChecks.map((check) => check.criterion));
}
