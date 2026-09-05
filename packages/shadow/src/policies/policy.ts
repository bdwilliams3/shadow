import { z } from "zod";
import type { ShadowConfig } from "../config/schema.js";

export const RiskClassSchema = z.enum([
  "read_only",
  "workspace_write",
  "external_write",
  "destructive"
]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ToolActionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  risk: RiskClassSchema,
  writesWorkspace: z.boolean().default(false),
  writesOutsideWorkspace: z.boolean().default(false),
  usesNetwork: z.boolean().default(false),
  deploys: z.boolean().default(false),
  touchesSecrets: z.boolean().default(false)
});
export type ToolAction = z.infer<typeof ToolActionSchema>;

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
}

export function evaluatePolicy(action: ToolAction, config: ShadowConfig): PolicyDecision {
  const reasons: string[] = [];

  if (action.writesOutsideWorkspace) {
    reasons.push("writes outside the active workspace");
  }
  if (action.touchesSecrets) {
    reasons.push("touches credentials or secrets");
  }
  if (action.writesWorkspace && !config.approvals.allowWorkspaceWrites) {
    reasons.push("workspace writes are disabled by policy");
  }
  if (action.risk === "destructive" && config.approvals.requireApprovalForDestructive) {
    reasons.push("action is destructive");
  }
  if (action.risk === "external_write" && config.approvals.requireApprovalForExternalWrites) {
    reasons.push("action writes to an external system");
  }
  if (action.usesNetwork && config.approvals.requireApprovalForNetwork) {
    reasons.push("action uses the network");
  }
  if (action.deploys && config.approvals.requireApprovalForDeploy) {
    reasons.push("action deploys to an external environment");
  }

  const blocked = action.writesWorkspace && !config.approvals.allowWorkspaceWrites;
  const requiresApproval =
    action.writesOutsideWorkspace ||
    action.touchesSecrets ||
    (action.risk === "destructive" && config.approvals.requireApprovalForDestructive) ||
    (action.risk === "external_write" && config.approvals.requireApprovalForExternalWrites) ||
    (action.usesNetwork && config.approvals.requireApprovalForNetwork) ||
    (action.deploys && config.approvals.requireApprovalForDeploy);

  return {
    allowed: !blocked,
    requiresApproval,
    reasons
  };
}
