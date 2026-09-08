import { resolveModelAlias, type ShadowConfig } from "../config/schema.js";
import { stageCallsModel } from "../orchestration/planner.js";
import type { Run, RunEvent, StageName } from "../orchestration/types.js";

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

export function formatStageModelMap(config: ShadowConfig): string {
  return Object.entries(config.agents)
    .map(([stage, alias]) => {
      const model = resolveModelAlias(config, alias);
      const target = model ? `${model.provider}/${model.model}` : "unresolved";
      const spend = model?.frontier ? "reserved" : "standard";
      const note = stage === "chat" || stageCallsModel(stage as StageName) ? spend : "deterministic";
      return `  ${stage.padEnd(8)} ${alias} -> ${target} (${note})`;
    })
    .join("\n");
}

export function formatRunPlan(run: Run): string {
  if (run.stageTasks.length === 0) {
    return "No plan has been recorded for this run yet.";
  }
  return run.stageTasks
    .map((task, index) => {
      const criteria = task.acceptanceCriteria.length > 0
        ? `\n    done: ${task.acceptanceCriteria.join("; ")}`
        : "";
      return `${index + 1}. ${task.stage}: ${task.goal}${criteria}`;
    })
    .join("\n");
}

export function formatRunBudget(run: Run, config: ShadowConfig): string {
  const usedTokens = run.usage.inputTokens + run.usage.outputTokens;
  return [
    `Run tokens: ${usedTokens}/${config.budgets.run.maxTotalTokens}`,
    `Run cost: $${run.usage.estimatedCostUsd.toFixed(4)}/$${config.budgets.run.maxEstimatedCostUsd.toFixed(2)} est.`,
    `Reserved budget: ${config.budgets.run.reservedFrontierTokens} tokens`
  ].join("\n");
}

export function formatRunChangedFiles(run: Run): string {
  const files = [...new Set(run.stageRuns.flatMap((stage) => stage.result?.changedFiles ?? []))];
  return files.length > 0 ? files.join("\n") : "No recorded file changes.";
}

export function formatProgressEvent(event: RunEvent): string | undefined {
  switch (event.type) {
    case "run.transition": {
      const to = String(event.payload.to ?? "");
      if (to === "CLASSIFIED" || to === "PLANNED") {
        return undefined;
      }
      return `state ${event.payload.from ?? "?"} -> ${event.payload.to ?? "?"}`;
    }
    case "run.replanned": {
      const after = Array.isArray(event.payload.after) ? event.payload.after.join(" -> ") : "updated";
      return `plan revised: ${after}`;
    }
    case "run.remediation_started":
      return `remediation: ${event.payload.failedStage ?? "stage"} will return to ${event.payload.resumeStage ?? "develop"}`;
    case "stage.started":
      return `${event.payload.stage ?? "stage"} started (attempt ${event.payload.attempt ?? 1}, ${event.payload.modelTier ?? "configured model"})`;
    case "stage.retrying":
      return `${event.payload.stage ?? "stage"} retrying: ${event.payload.reason ?? "previous attempt failed"}`;
    case "stage.completed":
      return `${event.payload.stage ?? "stage"} ${event.payload.status ?? "completed"}: ${event.payload.summary ?? ""}`;
    case "stage.cancelled":
      return `${event.payload.stage ?? "stage"} cancelled`;
    case "tool.completed":
      return `tool ${event.payload.actionId ?? "action"} ${event.payload.status ?? "completed"}: ${event.payload.summary ?? ""}`;
    case "model.completed": {
      const usage = event.payload.usage as { inputTokens?: unknown; outputTokens?: unknown; estimatedCostUsd?: unknown } | undefined;
      const tokens =
        Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0);
      const cost = Number(usage?.estimatedCostUsd ?? 0);
      return `model ${event.payload.provider ?? "provider"}/${event.payload.model ?? "model"} ${event.payload.status ?? "completed"}: ${tokens} tokens, $${cost.toFixed(4)} est.`;
    }
    case "approval.requested":
      return `approval needed for ${event.payload.operation ?? "operation"} (${event.payload.approvalId ?? "pending"})`;
    case "approval.resolved":
      return `approval ${event.payload.decision ?? "resolved"} for ${event.payload.operation ?? "operation"}`;
    case "run.cancelled":
      return "cancellation requested";
    default:
      return undefined;
  }
}
