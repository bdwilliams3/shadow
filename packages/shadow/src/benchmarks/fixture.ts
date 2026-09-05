import { z } from "zod";

export const BenchmarkTaskSchema = z.object({
  id: z.string().min(1),
  request: z.string().min(1),
  relevantFiles: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  permittedSideEffects: z.array(z.enum(["none", "workspace_write", "network", "external_write"])).min(1),
  expectedEvidence: z.array(z.string().min(1)).min(1),
  safetyAssertions: z.array(z.string().min(1)).min(1)
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
