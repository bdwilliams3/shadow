import type { Run } from "../orchestration/types.js";

export function formatRunSummary(run: Run): string {
  const stages = run.stageRuns
    .map((stage) => `${stage.stage}:${stage.status}[${stage.attempts}]`)
    .join(", ");
  const risks = run.openRisks.length > 0 ? `\nRisks: ${run.openRisks.join("; ")}` : "";
  const approvals = run.approvals.length > 0
    ? `\nApprovals: ${run.approvals.map((approval) => `${approval.id}:${approval.operation}:${approval.status}`).join(", ")}`
    : "";
  const toolCalls = run.stageRuns.flatMap((stage) => stage.result?.toolCalls ?? []);
  const changedFiles = [...new Set(run.stageRuns.flatMap((stage) => stage.result?.changedFiles ?? []))];
  return [
    `Run ${run.id}`,
    `State: ${run.state}`,
    `Workspace: ${run.workspaceRoot}`,
    `Request: ${run.request}`,
    `Stages: ${stages || "none"}`,
    `Actions: ${toolCalls.length}`,
    `Files changed: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`,
    `Usage: ${run.usage.inputTokens + run.usage.outputTokens} tokens, $${run.usage.estimatedCostUsd.toFixed(4)} est.${approvals}${risks}`
  ].join("\n");
}
