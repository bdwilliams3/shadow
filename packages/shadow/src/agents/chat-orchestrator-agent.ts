import { z } from "zod";
import { ModelRouter, ModelRoutingError } from "../models/router.js";
import type { CapabilityTier, ModelCallRecord, UsageTotals } from "../orchestration/types.js";
import type { Budget } from "../orchestration/types.js";

export type ChatDecision = "keep_thinking" | "change_directions" | "start_coding";

export const ChatOrchestratorOutputSchema = z.object({
  decision: z.enum(["keep_thinking", "change_directions", "start_coding"]),
  reply: z.string().min(1),
  proposedObjective: z.string().nullable().default(null),
  confidence: z.enum(["low", "medium", "high"]).default("medium")
});
export type ChatOrchestratorOutput = z.infer<typeof ChatOrchestratorOutputSchema>;

export interface ChatOrchestratorInput {
  message: string;
  workspaceRoot: string;
  repositorySummary: string;
  highestPriorityNextStep?: string;
  changedFileCount: number;
  steeringNotes: string[];
}

export interface ChatOrchestratorResult {
  decision: ChatDecision;
  reply: string;
  proposedObjective?: string;
  modelCall?: ModelCallRecord;
  usage: UsageTotals;
}

const zeroUsage: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0
};

const systemPrompt = [
  "You are Shadow's configurable terminal coordinator agent.",
  "Chat naturally with the developer while staying grounded in the repository context provided.",
  "Choose exactly one decision: keep_thinking for discussion or read-only questions, change_directions when the user gives steering or revises the goal, start_coding only when the user has stated a concrete code/documentation change clearly enough to prepare for approval.",
  "Do not claim that coding, tests, validation, deployment, or file writes have happened. This coordinator is read-only.",
  "For capability questions, introduce Shadow as a customizable CLI coding agent that can Discuss, Plan, Design, Develop, Test, Validate, Deploy, and Document a codebase.",
  "For 'what next' questions, use the supplied highest-priority next step when present.",
  "If coding might be appropriate but the objective is still vague, keep_thinking and ask one concise question."
].join("\n");

export class ChatOrchestratorAgent {
  constructor(
    private readonly models: ModelRouter,
    private readonly modelAlias: CapabilityTier,
    private readonly budget: Budget
  ) {}

  async run(input: ChatOrchestratorInput, signal?: AbortSignal): Promise<ChatOrchestratorResult> {
    try {
      const completion = await this.models.completeStructured({
        tier: this.modelAlias,
        system: systemPrompt,
        input,
        schemaName: "shadow_chat_orchestrator_v1",
        schema: ChatOrchestratorOutputSchema,
        stageBudget: this.budget,
        stageUsage: zeroUsage,
        runBudget: this.budget,
        runUsage: zeroUsage,
        approved: true,
        ...(signal ? { signal } : {})
      });
      return {
        decision: completion.output.decision,
        reply: completion.output.reply,
        ...(completion.output.proposedObjective ? { proposedObjective: completion.output.proposedObjective } : {}),
        modelCall: completion.record,
        usage: completion.record.usage
      };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return {
          decision: "keep_thinking",
          reply: `I could not reach the configured chat coordinator model (${this.modelAlias}): ${error.message}`,
          modelCall: error.record,
          usage: error.record.usage
        };
      }
      throw error;
    }
  }
}
