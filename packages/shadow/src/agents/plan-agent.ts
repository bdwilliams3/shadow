import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";
import { ModelRouter, ModelRoutingError } from "../models/router.js";
import { StageNameSchema } from "../orchestration/types.js";
import type {
  CapabilityTier,
  PlanRevision,
  StageName,
  StageResult,
  StageTask
} from "../orchestration/types.js";
import type { GitStatusSummary } from "../tools/actions/git.js";
import type { RepositoryInventory } from "../tools/actions/repository.js";
import type { ActionRunner } from "../tools/runner.js";
import type { Agent, StageContext } from "./contract.js";

/**
 * Acceptance criteria are handed to a model as the definition of done. Too many turns an
 * ordinary edit into a specification the model would rather decline than satisfy, which
 * is exactly how a two-file change was once refused for lacking "orchestration,
 * persistence, budgeting, and policy-evaluation components". The model is told to stay
 * under this; the applier enforces it regardless of what comes back.
 */
export const maxCriteriaPerStage = 4;

/** Stages that consume acceptance criteria. Deterministic stages are given none. */
const criteriaConsumingStages = new Set<StageName>(["design", "develop", "document"]);

const RecommendedTierSchema = z.enum(["frontier", "balanced", "economy", "unspecified"]);

export const PlanOutputSchema = z.object({
  summary: z.string().default(""),
  complexity: z.enum(["low", "medium", "high"]).default("medium"),
  stages: z.array(StageNameSchema).default([]),
  tasks: z
    .array(
      z.object({
        stage: StageNameSchema,
        goal: z.string().default(""),
        acceptanceCriteria: z.array(z.string()).default([]),
        recommendedTier: RecommendedTierSchema.default("unspecified")
      })
    )
    .default([]),
  unknowns: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  approvalsRequired: z.array(z.string()).default([])
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

const systemPrompt = [
  "You are Shadow's Plan agent. You decide which lifecycle stages a request needs and what done means for each.",
  "Return JSON matching the supplied schema.",
  "",
  "Stages available: plan, design, develop, test, validate, deploy, document.",
  "Choose the smallest sufficient set. Most ordinary edit or fix requests need only develop, test, validate.",
  "Include design only for genuinely architectural or cross-cutting work, or a new project.",
  "Include deploy only when the request asks to deploy, release, or publish.",
  "Include document only when the request asks for documentation or the change is not self-evident.",
  "Never include plan; it has already run.",
  "",
  "Acceptance criteria are the definition of done for the user's requested change, and only that change.",
  "Each criterion must be checkable by reading the resulting diff or running the repository's tests.",
  "Write criteria only for design, develop, and document. Deterministic stages take none.",
  `Write at most ${maxCriteriaPerStage} per stage, and fewer when fewer will do.`,
  "Never write criteria about Shadow's own architecture, orchestration, persistence, budgeting, policy, or audit behaviour.",
  "Those describe the harness, not the user's task, and a stage handed them will refuse ordinary work.",
  "A one-line edit deserves one criterion, not four.",
  "",
  "Recommend a capability tier per stage only when the work clearly warrants something other than the default.",
  "Record genuine unknowns and risks. Do not invent them, and do not narrate tool use."
].join("\n");

/** Measurable repository signals, per §8's deterministic complexity scoring. */
export interface ComplexitySignals {
  fileCount: number;
  indexedFileCount: number;
  languages: string[];
  manifests: string[];
  changedFiles: number;
  requestWords: number;
  score: "low" | "medium" | "high";
}

export function scoreComplexity(
  inventory: RepositoryInventory | undefined,
  status: GitStatusSummary | undefined,
  request: string
): ComplexitySignals {
  const languages = Object.keys(inventory?.languages ?? {}).sort();
  const manifests = inventory?.manifests ?? [];
  const changedFiles = status?.changedFiles.length ?? 0;
  const requestWords = request.trim().split(/\s+/).filter(Boolean).length;
  // Deliberately coarse and measurable: repository breadth, existing change surface, and
  // how much the request itself asks for. It steers the model; it does not gate anything.
  let points = 0;
  if ((inventory?.fileCount ?? 0) > 200) points += 2;
  else if ((inventory?.fileCount ?? 0) > 40) points += 1;
  if (languages.length > 2) points += 1;
  if (manifests.length > 1) points += 1;
  if (changedFiles > 10) points += 1;
  if (requestWords > 60) points += 1;
  return {
    fileCount: inventory?.fileCount ?? 0,
    indexedFileCount: inventory?.indexedFileCount ?? 0,
    languages,
    manifests,
    changedFiles,
    requestWords,
    score: points >= 4 ? "high" : points >= 2 ? "medium" : "low"
  };
}

/**
 * Narrows a model's plan to something the orchestrator can act on: known stages only,
 * plan itself dropped, duplicates removed, criteria trimmed to the stages that consume
 * them and capped in number. Ordering, enablement, and tier clamping are the
 * orchestrator's job, since only it knows what has already run.
 */
export function toPlanRevision(output: PlanOutput, request: string): PlanRevision | undefined {
  const stages = [...new Set(output.stages)].filter((stage) => stage !== "plan");
  if (stages.length === 0) {
    return undefined;
  }
  const proposed = new Map(output.tasks.map((task) => [task.stage, task]));
  return {
    stages,
    tasks: stages.map((stage) => {
      const task = proposed.get(stage);
      const tier = task?.recommendedTier ?? "unspecified";
      const criteria = criteriaConsumingStages.has(stage)
        ? (task?.acceptanceCriteria ?? [])
            .map((criterion) => criterion.trim())
            .filter((criterion) => criterion.length > 0)
            .slice(0, maxCriteriaPerStage)
        : [];
      return {
        stage,
        goal: task?.goal.trim() || request,
        acceptanceCriteria: criteria,
        ...(tier === "unspecified" ? {} : { recommendedTier: tier as CapabilityTier })
      };
    }),
    unknowns: output.unknowns,
    approvalsRequired: output.approvalsRequired
  };
}

function planSummary(output: PlanOutput): string {
  return output.summary.trim() || "Plan produced a structured result with no summary.";
}

export class PlanAgent implements Agent {
  constructor(
    private readonly actions: ActionRunner,
    private readonly models: ModelRouter,
    private readonly artifacts: ArtifactStore,
    private readonly tier: CapabilityTier,
    /** The lifecycle stages configuration permits. A plan naming anything else is filtered. */
    private readonly enabledStages: readonly StageName[],
    private readonly databasePath = ".shadow/shadow.db",
    private readonly exclusions: string[] = []
  ) {}

  async run(task: StageTask, context: StageContext): Promise<StageResult> {
    const inspection = await this.actions.run<RepositoryInventory>(
      "repository.inspect",
      { databasePath: this.databasePath, exclusions: this.exclusions },
      { dryRun: context.dryRun }
    );
    const status = await this.actions.run<GitStatusSummary>("git.status", {}, {
      dryRun: context.dryRun
    });
    const toolCalls = [inspection.record, status.record];
    const producedArtifacts = [...inspection.artifacts, ...status.artifacts];
    const signals = scoreComplexity(inspection.output, status.output, context.request);
    const inventoryRisks =
      inspection.record.status === "failed" ? [inspection.record.summary] : [];

    try {
      const completion = await this.models.completeStructured({
        tier: this.tier,
        system: systemPrompt,
        input: {
          request: context.request,
          dryRun: context.dryRun,
          availableStages: this.selectableStages(),
          repository: {
            fileCount: signals.fileCount,
            indexedFileCount: signals.indexedFileCount,
            languages: signals.languages,
            manifests: signals.manifests,
            sampleFiles: inspection.output?.sampleFiles ?? [],
            changedFiles: status.output?.changedFiles ?? []
          },
          complexity: signals.score
        },
        schemaName: "shadow_plan_result_v1",
        schema: PlanOutputSchema,
        stageBudget: task.budget,
        stageUsage: context.stageUsage,
        runBudget: context.runBudget,
        runUsage: context.runUsage,
        approved: context.approvedOperations.includes("model.complete"),
        signal: context.signal
      });

      const revision = toPlanRevision(completion.output, context.request);
      const artifact = await this.artifacts.writeText(
        "plan.result",
        "plan.result.json",
        `${JSON.stringify({ signals, plan: completion.output }, null, 2)}\n`
      );
      producedArtifacts.push(artifact);

      if (!revision) {
        // A plan naming no stage is not a plan. Keep the bootstrap graph rather than
        // executing an empty lifecycle.
        return {
          status: "completed",
          summary: `${planSummary(completion.output)} Planned stages were unusable; the deterministic graph stands.`,
          decisions: [`Repository complexity scored ${signals.score}.`],
          artifacts: producedArtifacts,
          changedFiles: [],
          toolCalls,
          modelCalls: [completion.record],
          testResults: [],
          openRisks: [
            ...inventoryRisks,
            ...completion.output.risks,
            "Plan returned no usable stage list; the deterministic stage graph was kept."
          ],
          usage: completion.record.usage
        };
      }

      return {
        status: "completed",
        summary: planSummary(completion.output),
        decisions: [
          `Repository complexity scored ${signals.score}.`,
          `Planned stages: ${revision.stages.join(", ")}.`,
          ...revision.tasks
            .filter((planned) => planned.acceptanceCriteria.length > 0)
            .map(
              (planned) =>
                `${planned.stage} acceptance criteria: ${planned.acceptanceCriteria.length}.`
            )
        ],
        artifacts: producedArtifacts,
        changedFiles: [],
        toolCalls,
        modelCalls: [completion.record],
        testResults: [],
        openRisks: [
          ...inventoryRisks,
          ...completion.output.risks,
          ...completion.output.unknowns.map((unknown) => `Plan unknown: ${unknown}`)
        ],
        planRevision: revision,
        usage: completion.record.usage
      };
    } catch (error) {
      if (!(error instanceof ModelRoutingError)) throw error;
      // An approval pause is a real pause: the orchestrator must surface it and stop.
      if (error.record.approvalRequired) {
        return {
          status: "blocked",
          summary: error.message,
          decisions: [],
          artifacts: producedArtifacts,
          changedFiles: [],
          toolCalls,
          modelCalls: [error.record],
          testResults: [],
          openRisks: [...inventoryRisks, error.message],
          usage: error.record.usage
        };
      }
      // Anything else — budget refusal, transport failure, cancellation of this call —
      // falls back to the deterministic graph the run already has. Planning is an
      // improvement to the lifecycle, not a precondition for it, and one unreachable
      // provider should not cost the user the run.
      return {
        status: "completed",
        summary: `Planned deterministically: ${error.message}`,
        decisions: [`Repository complexity scored ${signals.score}.`],
        artifacts: producedArtifacts,
        changedFiles: [],
        toolCalls,
        modelCalls: [error.record],
        testResults: [],
        openRisks: [
          ...inventoryRisks,
          `Model-backed planning was unavailable (${error.message}); the deterministic stage graph was kept.`
        ],
        usage: error.record.usage
      };
    }
  }

  /** Stages a plan may choose from: configuration's list, minus Plan itself. */
  private selectableStages(): StageName[] {
    return this.enabledStages.filter((stage) => stage !== "plan");
  }
}
