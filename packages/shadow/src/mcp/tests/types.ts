import { z } from "zod";
import { ArtifactReferenceSchema } from "../../orchestration/types.js";

export const TestFrameworkSchema = z.enum(["auto", "vitest", "pytest"]);
export type TestFramework = z.infer<typeof TestFrameworkSchema>;

export const TestRunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "not_configured"
]);
export type TestRunStatus = z.infer<typeof TestRunStatusSchema>;

export const TestCountsSchema = z.object({
  passed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0)
});

export const TestFailureSchema = z.object({
  test_id: z.string().min(1),
  category: z.enum(["assertion", "error", "timeout", "unknown"]),
  message: z.string(),
  relevant_frames: z.array(z.string()).default([]),
  log_artifact_id: z.string().optional()
});
export type TestFailure = z.infer<typeof TestFailureSchema>;

export const CoverageSummarySchema = z.object({
  status: z.enum(["available", "unavailable"]),
  lines_percent: z.number().min(0).max(100).optional(),
  branches_percent: z.number().min(0).max(100).optional(),
  functions_percent: z.number().min(0).max(100).optional(),
  statements_percent: z.number().min(0).max(100).optional()
});
export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;

export const TestRunRequestSchema = z.object({
  workspace_id: z.string().min(1),
  framework: TestFrameworkSchema.default("auto"),
  selectors: z.array(z.string().min(1)).default([]),
  changed_files: z.array(z.string().min(1)).default([]),
  environment_profile: z.string().min(1).default("local-macos"),
  timeout_seconds: z.number().int().positive().max(3600).default(300),
  coverage: z.boolean().default(false),
  max_retries: z.number().int().nonnegative().max(3).default(1)
});
export type TestRunRequest = z.infer<typeof TestRunRequestSchema>;

export const TestRunAcceptedSchema = z.object({
  run_id: z.string().min(1),
  status: TestRunStatusSchema
});
export type TestRunAccepted = z.infer<typeof TestRunAcceptedSchema>;

export const TestRunSummarySchema = z.object({
  run_id: z.string().min(1),
  framework: z.enum(["vitest", "pytest"]).optional(),
  status: TestRunStatusSchema,
  counts: TestCountsSchema,
  failures: z.array(TestFailureSchema).default([]),
  duration_ms: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  artifacts: z.array(ArtifactReferenceSchema).default([]),
  coverage: CoverageSummarySchema.default({ status: "unavailable" }),
  message: z.string().optional()
});
export type TestRunSummary = z.infer<typeof TestRunSummarySchema>;

export const DiscoverTestsRequestSchema = z.object({
  workspace_id: z.string().min(1),
  framework: TestFrameworkSchema.default("auto")
});

export const DiscoverTestsResultSchema = z.object({
  framework: z.enum(["vitest", "pytest"]).optional(),
  tests: z.array(z.string()),
  status: z.enum(["completed", "not_configured", "failed"]),
  message: z.string().optional()
});
export type DiscoverTestsResult = z.infer<typeof DiscoverTestsResultSchema>;

export const TestRunLookupSchema = z.object({ run_id: z.string().min(1) });
export const FailureDetailsRequestSchema = TestRunLookupSchema.extend({
  test_id: z.string().min(1).optional()
});
export const FailureDetailsResultSchema = z.object({
  run_id: z.string().min(1),
  failures: z.array(TestFailureSchema)
});

export const CancelTestRunResultSchema = z.object({
  run_id: z.string().min(1),
  status: TestRunStatusSchema
});

export const CoverageResultSchema = z.object({
  run_id: z.string().min(1),
  coverage: CoverageSummarySchema
});
