import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";
import { loadArtifactContext } from "../context/artifact-context.js";
import { ModelRouter, ModelRoutingError } from "../models/router.js";
import type { CapabilityTier, StageResult, StageTask } from "../orchestration/types.js";
import type {
  ContextVerification,
  SelectedContext
} from "../tools/actions/context.js";
import type { PatchResult } from "../tools/actions/patch.js";
import type { ActionRunner } from "../tools/runner.js";
import type { Agent, StageContext } from "./contract.js";

export const DocumentOutputSchema = z.object({
  summary: z.string().min(1),
  patch: z.string().max(500_000).default(""),
  changeSummary: z.array(z.string()).default([]),
  migrationNotes: z.array(z.string()).default([]),
  operationalNotes: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  openRisks: z.array(z.string()).default([])
});
export type DocumentOutput = z.infer<typeof DocumentOutputSchema>;

const systemPrompt = [
  "You are Shadow's bounded Document agent.",
  "Update documentation only for behavior proven by the supplied implementation and test artifacts.",
  "Return JSON matching the supplied schema. Use an empty patch when existing documentation needs no change.",
  "A non-empty patch must be a standard unified Git diff and may modify only supplied documentation files.",
  "Do not document planned, skipped, failed, or unimplemented behavior. Keep notes concise."
].join("\n");

export class DocumentAgent implements Agent {
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
      request: `${context.request} README documentation changelog migration operations`,
      candidatePaths: ["README.md", "CHANGELOG.md"],
      databasePath: this.databasePath,
      exclusions: this.exclusions,
      maxFiles: 12,
      maxBytes: 80_000
    }, { dryRun: context.dryRun });
    const documentationFiles = (selection.output?.files ?? []).filter((file) => isDocumentationPath(file.path));
    if (documentationFiles.length === 0) {
      return {
        status: "skipped",
        summary: "No existing documentation files were available for a bounded update.",
        decisions: [],
        artifacts: selection.artifacts,
        changedFiles: [],
        toolCalls: [selection.record],
        modelCalls: [],
        testResults: [],
        openRisks: ["Documentation creation is not yet enabled; only existing files can be updated."],
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      };
    }
    const evidence = await loadArtifactContext(
      this.artifacts,
      [...task.inputs].sort(
        (left, right) => evidencePriority(left.kind) - evidencePriority(right.kind)
      ),
      new Set(["develop.patch", "design.result", "action.result"]),
      50_000
    );
    const actionRecords = [selection.record];
    const producedArtifacts = [...selection.artifacts];

    try {
      const completion = await this.models.completeStructured({
        tier: this.tier,
        system: systemPrompt,
        input: {
          request: context.request,
          acceptanceCriteria: task.acceptanceCriteria,
          documentationFiles,
          implementationEvidence: evidence
        },
        schemaName: "shadow_document_result_v1",
        schema: DocumentOutputSchema,
        stageBudget: task.budget,
        stageUsage: context.stageUsage,
        runBudget: context.runBudget,
        runUsage: context.runUsage,
        approved: context.approvedOperations.includes("model.complete"),
        signal: context.signal
      });
      const resultArtifact = await this.artifacts.writeText(
        "document.result",
        "document.result.json",
        `${JSON.stringify(completion.output, null, 2)}\n`
      );
      producedArtifacts.push(resultArtifact);
      if (completion.output.patch.trim().length === 0) {
        return this.resultWithoutPatch(completion.output, completion.record, producedArtifacts, actionRecords);
      }

      const check = await this.actions.run<PatchResult>(
        "patch.check",
        { patch: completion.output.patch },
        { dryRun: context.dryRun }
      );
      actionRecords.push(check.record);
      producedArtifacts.push(...check.artifacts);
      const allowedPaths = new Set(documentationFiles.map((file) => file.path));
      const outOfScope = (check.output?.changedFiles ?? []).filter((path) => !allowedPaths.has(path));
      if (!check.output?.valid || outOfScope.length > 0) {
        const reason = outOfScope.length > 0
          ? `Documentation patch exceeded its file scope: ${outOfScope.join(", ")}`
          : check.record.summary;
        return this.patchResult("failed", reason, completion.output, completion.record, producedArtifacts, actionRecords, check.output?.changedFiles ?? []);
      }
      if (context.dryRun) {
        return this.patchResult("completed", `Dry run validated documentation changes to ${check.output.changedFiles.length} files.`, completion.output, completion.record, producedArtifacts, actionRecords, check.output.changedFiles, ["Documentation patch was not applied in dry-run mode."]);
      }

      const verification = await this.actions.run<ContextVerification>("context.verify", {
        files: documentationFiles.map((file) => ({ path: file.path, sha256: file.sha256 }))
      });
      actionRecords.push(verification.record);
      producedArtifacts.push(...verification.artifacts);
      if (!verification.output?.valid) {
        return this.patchResult("blocked", verification.record.summary, completion.output, completion.record, producedArtifacts, actionRecords, check.output.changedFiles, ["Documentation changed after context selection."]);
      }
      const apply = await this.actions.run<PatchResult>(
        "patch.apply",
        { patch: completion.output.patch },
        {
          allowWorkspaceWrites: task.writePermissions,
          approved: context.approvedOperations.includes("patch.apply")
        }
      );
      actionRecords.push(apply.record);
      producedArtifacts.push(...apply.artifacts);
      return this.patchResult(
        apply.output?.applied ? "completed" : apply.record.status === "blocked" ? "blocked" : "failed",
        apply.record.summary,
        completion.output,
        completion.record,
        producedArtifacts,
        actionRecords,
        apply.output?.changedFiles ?? check.output.changedFiles,
        apply.output?.applied ? [] : [apply.record.summary]
      );
    } catch (error) {
      if (!(error instanceof ModelRoutingError)) throw error;
      return {
        status: context.dryRun ? "skipped" : "blocked",
        summary: error.message,
        decisions: [],
        artifacts: producedArtifacts,
        changedFiles: [],
        toolCalls: actionRecords,
        modelCalls: [error.record],
        testResults: [],
        openRisks: [error.message],
        usage: error.record.usage
      };
    }
  }

  private resultWithoutPatch(
    output: DocumentOutput,
    modelCall: StageResult["modelCalls"][number],
    artifacts: StageResult["artifacts"],
    toolCalls: StageResult["toolCalls"]
  ): StageResult {
    return {
      status: "completed",
      summary: output.summary,
      decisions: output.decisions,
      artifacts,
      changedFiles: [],
      toolCalls,
      modelCalls: [modelCall],
      testResults: [],
      openRisks: output.openRisks,
      usage: modelCall.usage
    };
  }

  private patchResult(
    status: StageResult["status"],
    summary: string,
    output: DocumentOutput,
    modelCall: StageResult["modelCalls"][number],
    artifacts: StageResult["artifacts"],
    toolCalls: StageResult["toolCalls"],
    changedFiles: string[],
    additionalRisks: string[] = []
  ): StageResult {
    return {
      status,
      summary,
      decisions: output.decisions,
      artifacts,
      changedFiles,
      toolCalls,
      modelCalls: [modelCall],
      testResults: [],
      openRisks: [...output.openRisks, ...additionalRisks],
      usage: modelCall.usage
    };
  }
}

function isDocumentationPath(path: string): boolean {
  return /(?:^|\/)(?:README|CHANGELOG|MIGRATION|CONTRIBUTING)(?:\.[^/]*)?$/i.test(path) ||
    /(?:^|\/)docs\/.*\.(?:md|mdx|txt)$/i.test(path) ||
    /\.(?:md|mdx|rst)$/i.test(path);
}

function evidencePriority(kind: string): number {
  if (kind === "develop.patch") return 0;
  if (kind === "design.result") return 1;
  return 2;
}
