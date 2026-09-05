import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";
import { loadArtifactContext } from "../context/artifact-context.js";
import { ModelRouter, ModelRoutingError } from "../models/router.js";
import type { CapabilityTier, StageResult, StageTask } from "../orchestration/types.js";
import type { SelectedContext } from "../tools/actions/context.js";
import type { ActionRunner } from "../tools/runner.js";
import type { Agent, StageContext } from "./contract.js";

export const DesignOutputSchema = z.object({
  summary: z.string().min(1),
  decisions: z.array(z.object({
    title: z.string().min(1),
    decision: z.string().min(1),
    rationale: z.string().min(1),
    consequences: z.array(z.string()).default([])
  })).default([]),
  interfaces: z.array(z.object({
    name: z.string().min(1),
    responsibility: z.string().min(1),
    inputs: z.array(z.string()).default([]),
    outputs: z.array(z.string()).default([])
  })).default([]),
  migration: z.array(z.string()).default([]),
  openRisks: z.array(z.string()).default([])
});
export type DesignOutput = z.infer<typeof DesignOutputSchema>;

const systemPrompt = [
  "You are Shadow's bounded Design agent.",
  "Turn the approved goal into compact interfaces, module boundaries, migration steps, and explicit design decisions.",
  "Use only supplied repository context and structured artifacts.",
  "Return JSON matching the supplied schema. Do not propose implementation beyond the request.",
  "Keep risks concrete and do not narrate routine tool use."
].join("\n");

export class DesignAgent implements Agent {
  constructor(
    private readonly actions: ActionRunner,
    private readonly models: ModelRouter,
    private readonly artifacts: ArtifactStore,
    private readonly tier: CapabilityTier,
    private readonly databasePath: string,
    private readonly exclusions: string[]
  ) {}

  async run(task: StageTask, context: StageContext): Promise<StageResult> {
    const selection = await this.actions.run<SelectedContext>("context.select", {
      request: context.request,
      databasePath: this.databasePath,
      exclusions: this.exclusions,
      maxFiles: 8,
      maxBytes: 60_000
    }, { dryRun: context.dryRun });
    const inputArtifacts = await loadArtifactContext(
      this.artifacts,
      task.inputs,
      new Set(["action.result"]),
      20_000
    );
    try {
      const completion = await this.models.completeStructured({
        tier: this.tier,
        system: systemPrompt,
        input: {
          goal: task.goal,
          constraints: task.constraints,
          acceptanceCriteria: task.acceptanceCriteria,
          repositoryFiles: selection.output?.files ?? [],
          priorArtifacts: inputArtifacts
        },
        schemaName: "shadow_design_result_v1",
        schema: DesignOutputSchema,
        stageBudget: task.budget,
        stageUsage: context.stageUsage,
        runBudget: context.runBudget,
        runUsage: context.runUsage,
        approved: context.approvedOperations.includes("model.complete"),
        signal: context.signal
      });
      const artifact = await this.artifacts.writeText(
        "design.result",
        "design.result.json",
        `${JSON.stringify(completion.output, null, 2)}\n`
      );
      return {
        status: "completed",
        summary: completion.output.summary,
        decisions: completion.output.decisions.map(
          (decision) => `${decision.title}: ${decision.decision}`
        ),
        artifacts: [...selection.artifacts, artifact],
        changedFiles: [],
        toolCalls: [selection.record],
        modelCalls: [completion.record],
        testResults: [],
        openRisks: completion.output.openRisks,
        usage: completion.record.usage
      };
    } catch (error) {
      if (!(error instanceof ModelRoutingError)) throw error;
      return {
        status: context.dryRun ? "skipped" : "blocked",
        summary: error.message,
        decisions: [],
        artifacts: selection.artifacts,
        changedFiles: [],
        toolCalls: [selection.record],
        modelCalls: [error.record],
        testResults: [],
        openRisks: [error.message],
        usage: error.record.usage
      };
    }
  }
}
