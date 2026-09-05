import type { Budget, StageResult, StageTask, UsageTotals } from "../orchestration/types.js";

export interface StageContext {
  workspaceRoot: string;
  request: string;
  dryRun: boolean;
  stageUsage: UsageTotals;
  runBudget: Budget;
  runUsage: UsageTotals;
  approvedOperations: readonly string[];
  signal: AbortSignal;
}

export interface Agent {
  run(task: StageTask, context: StageContext): Promise<StageResult>;
}
