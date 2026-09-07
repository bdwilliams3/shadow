import { z } from "zod";

export const StageNameSchema = z.enum([
  "plan",
  "design",
  "develop",
  "test",
  "validate",
  "deploy",
  "document"
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const ModelAliasSchema = z.string().min(1);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

/**
 * Historical name retained for persisted run compatibility. New configuration treats the
 * value as a direct model alias, not as a capability tier.
 */
export const CapabilityTierSchema = ModelAliasSchema;
export type CapabilityTier = ModelAlias;

export const RunStateSchema = z.enum([
  "RECEIVED",
  "CLASSIFIED",
  "PLANNED",
  "EXECUTING",
  "TESTING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "DEPLOYING",
  "DOCUMENTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const StageStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "skipped",
  "blocked",
  "failed",
  "cancelled"
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const UsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().default(0)
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

const defaultUsageTotals: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0
};

export const BudgetSchema = z.object({
  maxInputTokens: z.number().int().positive().default(120_000),
  maxOutputTokens: z.number().int().positive().default(24_000),
  maxTotalTokens: z.number().int().positive().default(144_000),
  maxEstimatedCostUsd: z.number().positive().default(10),
  reservedFrontierTokens: z.number().int().nonnegative().default(20_000)
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ArtifactReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative()
});
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const ToolCallRecordSchema = z.object({
  actionId: z.string().min(1),
  actionVersion: z.number().int().positive(),
  status: z.enum(["completed", "skipped", "blocked", "failed"]),
  cwd: z.string().min(1),
  commands: z.array(z.array(z.string())).default([]),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  summary: z.string(),
  approvalRequired: z.boolean().default(false),
  artifacts: z.array(ArtifactReferenceSchema).default([])
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const ModelCallRecordSchema = z.object({
  id: z.string().min(1),
  tier: CapabilityTierSchema,
  modelAlias: ModelAliasSchema.optional(),
  frontier: z.boolean().default(false),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(["completed", "blocked", "failed"]),
  estimatedInputTokens: z.number().int().nonnegative(),
  requestedOutputTokens: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  usage: UsageTotalsSchema,
  approvalRequired: z.boolean().default(false),
  reason: z.string().optional()
});
export type ModelCallRecord = z.infer<typeof ModelCallRecordSchema>;

export const StageTaskSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stage: StageNameSchema,
  goal: z.string().min(1),
  inputs: z.array(ArtifactReferenceSchema).default([]),
  constraints: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
  writePermissions: z.boolean().default(false),
  acceptanceCriteria: z.array(z.string()).default([]),
  allowedChangedFiles: z.array(z.string().min(1)).optional(),
  budget: BudgetSchema,
  retryCount: z.number().int().nonnegative().default(0),
  deadlineEpochMs: z.number().int().positive().optional()
});
export type StageTask = z.infer<typeof StageTaskSchema>;

/**
 * A revision of the not-yet-executed part of the lifecycle graph, produced by the Plan
 * stage. It is a *proposal*: the orchestrator filters, orders, and clamps it before any
 * of it takes effect, and it can never reach a stage that has already run.
 */
export const PlannedStageTaskSchema = z.object({
  stage: StageNameSchema,
  goal: z.string(),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  /**
   * A capability tier the plan believes this stage needs. Honoured only when it is at or
   * below the configured tier for the stage; an upgrade is recorded as an open risk
   * instead of applied, so configuration stays the authority on spend.
   */
  recommendedTier: CapabilityTierSchema.optional()
});
export type PlannedStageTask = z.infer<typeof PlannedStageTaskSchema>;

export const PlanRevisionSchema = z.object({
  stages: z.array(StageNameSchema).min(1),
  tasks: z.array(PlannedStageTaskSchema).default([]),
  risks: z.array(z.string()).default([])
});
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

export const StageResultSchema = z.object({
  status: StageStatusSchema,
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  artifacts: z.array(ArtifactReferenceSchema).default([]),
  changedFiles: z.array(z.string()).default([]),
  toolCalls: z.array(ToolCallRecordSchema).default([]),
  modelCalls: z.array(ModelCallRecordSchema).default([]),
  testResults: z.array(z.string()).default([]),
  openRisks: z.array(z.string()).default([]),
  recommendedNextStage: StageNameSchema.optional(),
  /**
   * Set only by the Plan stage. Optional so results persisted before the model-backed
   * planner existed still parse.
   */
  planRevision: PlanRevisionSchema.optional(),
  usage: UsageTotalsSchema.default(defaultUsageTotals)
});
export type StageResult = z.infer<typeof StageResultSchema>;

export const StageRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stage: StageNameSchema,
  status: StageStatusSchema,
  modelTier: CapabilityTierSchema,
  attempts: z.number().int().nonnegative().default(0),
  attemptResults: z.array(StageResultSchema).default([]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  result: StageResultSchema.optional()
});
export type StageRun = z.infer<typeof StageRunSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stageTaskId: z.string().min(1),
  stage: StageNameSchema,
  operation: z.string().min(1),
  reasons: z.array(z.string()).default([]),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional()
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  request: z.string().min(1),
  state: RunStateSchema,
  dryRun: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  stageTasks: z.array(StageTaskSchema).default([]),
  stageRuns: z.array(StageRunSchema).default([]),
  approvals: z.array(ApprovalRecordSchema).default([]),
  cancellationRequestedAt: z.string().optional(),
  usage: UsageTotalsSchema.default(defaultUsageTotals),
  openRisks: z.array(z.string()).default([])
});
export type Run = z.infer<typeof RunSchema>;

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()).default({})
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const stageOrder: StageName[] = [
  "plan",
  "design",
  "develop",
  "test",
  "validate",
  "deploy",
  "document"
];
