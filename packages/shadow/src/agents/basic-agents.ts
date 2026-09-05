import { z } from "zod";
import type { Agent, StageContext } from "./contract.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { TestsExecutor } from "../mcp/tests/client.js";
import type { TestRunSummary } from "../mcp/tests/types.js";
import { ModelRouter, ModelRoutingError } from "../models/router.js";
import type {
  CapabilityTier,
  StageResult,
  StageTask,
  ToolCallRecord
} from "../orchestration/types.js";
import type { ContextVerification, SelectedContext } from "../tools/actions/context.js";
import type { ActionRunner } from "../tools/runner.js";
import type { GitStatusSummary } from "../tools/actions/git.js";
import type { PatchResult } from "../tools/actions/patch.js";
import type { QualityResult } from "../tools/actions/quality.js";
import type { RepositoryInventory } from "../tools/actions/repository.js";
import type { TestSelection } from "../tools/actions/tests.js";

const noUsage = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0
};

export const DevelopOutputSchema = z.object({
  summary: z.string().min(1),
  patch: z.string().min(1).max(500_000),
  decisions: z.array(z.string()).default([]),
  openRisks: z.array(z.string()).default([])
});
export type DevelopOutput = z.infer<typeof DevelopOutputSchema>;

const developSystemPrompt = [
  "You are Shadow's bounded Develop agent.",
  "Implement only the requested change using the supplied files and acceptance criteria.",
  "Return JSON matching the supplied schema.",
  "The patch must be a standard unified Git diff with workspace-relative paths.",
  "Do not delete files, create symlinks, include binary patches, modify files absent from context, or add unrelated changes.",
  "Do not narrate tool use. Keep decisions and risks concise."
].join("\n");

export class PlanAgent implements Agent {
  constructor(
    private readonly actions: ActionRunner,
    private readonly databasePath = ".shadow/shadow.db",
    private readonly exclusions: string[] = []
  ) {}

  async run(task: StageTask, context: StageContext): Promise<StageResult> {
    const inspection = await this.actions.run<RepositoryInventory>("repository.inspect", {
      databasePath: this.databasePath,
      exclusions: this.exclusions
    }, {
      dryRun: context.dryRun
    });
    const inventory = inspection.output;
    return {
      status: "completed",
      summary: inventory
        ? `Planned lifecycle work using an inventory of ${inventory.fileCount} relevant files.`
        : `Planned lifecycle work for: ${context.request}`,
      decisions: [
        "Use capability tiers rather than hard-coded model names.",
        "Pass structured artifacts between stages.",
        "Keep deterministic actions behind the tool gateway."
      ],
      artifacts: [...task.inputs, ...inspection.artifacts],
      changedFiles: [],
      toolCalls: [inspection.record],
      modelCalls: [],
      testResults: [],
      openRisks: inspection.record.status === "failed" ? [inspection.record.summary] : [],
      usage: noUsage
    };
  }
}

export class DevelopAgent implements Agent {
  constructor(
    private readonly actions: ActionRunner,
    private readonly models: ModelRouter,
    private readonly artifacts: ArtifactStore,
    private readonly tier: CapabilityTier,
    private readonly databasePath = ".shadow/shadow.db",
    private readonly exclusions: string[] = []
  ) {}

  async run(task: StageTask, context: StageContext): Promise<StageResult> {
    const selection = await this.actions.run<SelectedContext>(
      "context.select",
      { request: context.request, databasePath: this.databasePath, exclusions: this.exclusions },
      { dryRun: context.dryRun }
    );
    const status = await this.actions.run<GitStatusSummary>("git.status", {}, {
      dryRun: context.dryRun
    });
    const actionRecords = [selection.record, status.record];
    const producedArtifacts = [...selection.artifacts, ...status.artifacts];

    if (!selection.output || selection.output.files.length === 0) {
      return {
        status: context.dryRun ? "skipped" : "blocked",
        summary: "No relevant text files were available for a bounded Develop call.",
        decisions: [],
        artifacts: producedArtifacts,
        changedFiles: [],
        toolCalls: actionRecords,
        modelCalls: [],
        testResults: [],
        openRisks: ["Develop requires at least one selected text file."],
        usage: noUsage
      };
    }

    try {
      const completion = await this.models.completeStructured({
        tier: this.tier,
        system: developSystemPrompt,
        input: {
          request: context.request,
          acceptanceCriteria: task.acceptanceCriteria,
          constraints: task.constraints,
          existingChanges: status.output?.entries ?? [],
          files: selection.output.files
        },
        schemaName: "shadow_develop_result_v1",
        schema: DevelopOutputSchema,
        stageBudget: task.budget,
        stageUsage: context.stageUsage,
        runBudget: context.runBudget,
        runUsage: context.runUsage,
        approved: context.approvedOperations.includes("model.complete"),
        signal: context.signal
      });
      const patchArtifact = await this.artifacts.writeText(
        "develop.patch",
        "develop.patch",
        completion.output.patch
      );
      producedArtifacts.push(patchArtifact);

      const check = await this.actions.run<PatchResult>(
        "patch.check",
        { patch: completion.output.patch },
        { dryRun: context.dryRun }
      );
      actionRecords.push(check.record);
      producedArtifacts.push(...check.artifacts);
      if (!check.output?.valid) {
        return {
          status: "failed",
          summary: check.record.summary,
          decisions: completion.output.decisions,
          artifacts: producedArtifacts,
          changedFiles: check.output?.changedFiles ?? [],
          toolCalls: actionRecords,
          modelCalls: [completion.record],
          testResults: [],
          openRisks: [...completion.output.openRisks, check.output?.diagnostics ?? "Invalid patch."],
          usage: completion.record.usage
        };
      }

      const selectedPaths = new Set(selection.output.files.map((file) => file.path));
      const unselectedChanges = check.output.changedFiles.filter((file) => !selectedPaths.has(file));
      if (unselectedChanges.length > 0) {
        return {
          status: "failed",
          summary: `Patch attempted to modify files outside the selected context: ${unselectedChanges.join(", ")}`,
          decisions: completion.output.decisions,
          artifacts: producedArtifacts,
          changedFiles: check.output.changedFiles,
          toolCalls: actionRecords,
          modelCalls: [completion.record],
          testResults: [],
          openRisks: [...completion.output.openRisks, "The patch exceeded the bounded file scope."],
          usage: completion.record.usage
        };
      }

      if (context.dryRun) {
        return {
          status: "completed",
          summary: `Dry run produced a valid patch affecting ${check.output.changedFiles.length} files.`,
          decisions: completion.output.decisions,
          artifacts: producedArtifacts,
          changedFiles: check.output.changedFiles,
          toolCalls: actionRecords,
          modelCalls: [completion.record],
          testResults: [],
          openRisks: [
            ...completion.output.openRisks,
            ...(selection.output.redactionCount > 0 ? ["Potential secrets were redacted from model context."] : []),
            "Patch was validated but not applied in dry-run mode."
          ],
          usage: completion.record.usage
        };
      }

      const verification = await this.actions.run<ContextVerification>("context.verify", {
        files: selection.output.files.map((file) => ({ path: file.path, sha256: file.sha256 }))
      });
      actionRecords.push(verification.record);
      producedArtifacts.push(...verification.artifacts);
      if (!verification.output?.valid) {
        return {
          status: "blocked",
          summary: verification.record.summary,
          decisions: completion.output.decisions,
          artifacts: producedArtifacts,
          changedFiles: check.output.changedFiles,
          toolCalls: actionRecords,
          modelCalls: [completion.record],
          testResults: [],
          openRisks: [
            ...completion.output.openRisks,
            "Workspace content changed after model context selection; a fresh Develop attempt is required."
          ],
          usage: completion.record.usage
        };
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
      return {
        status: apply.output?.applied ? "completed" : apply.record.status === "blocked" ? "blocked" : "failed",
        summary: apply.record.summary,
        decisions: completion.output.decisions,
        artifacts: producedArtifacts,
        changedFiles: apply.output?.changedFiles ?? check.output.changedFiles,
        toolCalls: actionRecords,
        modelCalls: [completion.record],
        testResults: [],
        openRisks: [
          ...completion.output.openRisks,
          ...(selection.output.redactionCount > 0 ? ["Potential secrets were redacted from model context."] : []),
          ...(apply.output?.applied ? [] : [apply.record.summary])
        ],
        usage: completion.record.usage
      };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
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
      throw error;
    }
  }
}

export class TestAgent implements Agent {
  constructor(
    private readonly actions: ActionRunner,
    private readonly tests?: TestsExecutor,
    private readonly databasePath = ".shadow/shadow.db",
    private readonly exclusions: string[] = []
  ) {}

  async run(_task: StageTask, context: StageContext): Promise<StageResult> {
    const git = await this.actions.run<GitStatusSummary>("git.status", {}, {
      dryRun: context.dryRun
    });
    const selection = await this.actions.run<TestSelection>("tests.select", {
      changedFiles: git.output?.changedFiles ?? [],
      databasePath: this.databasePath,
      exclusions: this.exclusions
    }, {
      dryRun: context.dryRun
    });
    const selectors = selection.output?.selectors ?? [];
    const preludeRecords = [git.record, selection.record];
    const preludeArtifacts = [...git.artifacts, ...selection.artifacts];
    let fallbackReason: string | undefined;
    if (this.tests && !context.dryRun) {
      const startedAt = performance.now();
      try {
        const summary = await this.tests.runTests(
          {
            workspace_id: context.workspaceRoot,
            framework: "auto",
            selectors,
            changed_files: git.output?.changedFiles ?? [],
            environment_profile: "local-macos",
            timeout_seconds: 300,
            coverage: false,
            max_retries: 1
          },
          context.signal
        );
        if (summary.status !== "not_configured") {
          return this.mcpResult(
            summary,
            context.workspaceRoot,
            Math.round(performance.now() - startedAt),
            preludeRecords,
            preludeArtifacts,
            selection.output?.strategy
          );
        }
        fallbackReason = summary.message ?? "Tests MCP did not detect a supported test framework.";
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error);
      }
    }

    const execution = await this.actions.run<QualityResult>("quality.test", { selectors }, {
      dryRun: context.dryRun
    });
    const testStatus = execution.output?.status;
    return {
      status: testStatus === "failed" || execution.record.status === "failed"
        ? "failed"
        : testStatus === "not_configured"
          ? "skipped"
          : "completed",
      summary: execution.record.summary,
      decisions: [
        `Test selection strategy: ${selection.output?.strategy ?? "full_suite"}.`,
        ...(fallbackReason ? [`Tests MCP fallback: ${fallbackReason}`] : [])
      ],
      artifacts: [...preludeArtifacts, ...execution.artifacts],
      changedFiles: [],
      toolCalls: [...preludeRecords, execution.record],
      modelCalls: [],
      testResults: testStatus ? [testStatus] : [],
      openRisks: testStatus === "not_configured" ? ["No repository test command is configured."] : [],
      usage: noUsage
    };
  }

  private mcpResult(
    summary: TestRunSummary,
    cwd: string,
    durationMs: number,
    preludeRecords: ToolCallRecord[],
    preludeArtifacts: StageResult["artifacts"],
    strategy?: TestSelection["strategy"]
  ): StageResult {
    const failed = ["failed", "timed_out"].includes(summary.status);
    const record: ToolCallRecord = {
      actionId: "mcp.tests.run_tests",
      actionVersion: 1,
      status: "completed",
      cwd,
      commands: [],
      exitCode: failed ? 1 : 0,
      durationMs,
      summary: `${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped via Tests MCP.`,
      approvalRequired: false,
      artifacts: summary.artifacts
    };
    return {
      status: failed ? "failed" : summary.status === "cancelled" ? "cancelled" : "completed",
      summary: record.summary,
      decisions: [
        `Test selection strategy: ${strategy ?? "full_suite"}.`,
        `Used the ${summary.framework ?? "configured"} Tests MCP adapter.`
      ],
      artifacts: [...preludeArtifacts, ...summary.artifacts],
      changedFiles: [],
      toolCalls: [...preludeRecords, record],
      modelCalls: [],
      testResults: [
        `passed=${summary.counts.passed}`,
        `failed=${summary.counts.failed}`,
        `skipped=${summary.counts.skipped}`
      ],
      openRisks: summary.failures.map((failure) => `${failure.test_id}: ${failure.message}`),
      usage: noUsage
    };
  }
}

export class ValidateAgent implements Agent {
  constructor(private readonly actions: ActionRunner) {}

  async run(_task: StageTask, context: StageContext): Promise<StageResult> {
    const [git, typecheck] = await Promise.all([
      this.actions.run<GitStatusSummary>("git.status", {}, { dryRun: context.dryRun }),
      this.actions.run<QualityResult>("quality.typecheck", {}, { dryRun: context.dryRun })
    ]);
    const typecheckStatus = typecheck.output?.status;
    const failed = typecheckStatus === "failed" || typecheck.record.status === "failed";
    const risks: string[] = [];
    if (!git.output?.repository) {
      risks.push("Workspace is not a Git repository; diff-scope validation is unavailable.");
    }
    if (typecheckStatus === "not_configured") {
      risks.push("No repository type-check command is configured.");
    }

    return {
      status: failed ? "failed" : "completed",
      summary: failed
        ? typecheck.record.summary
        : `Validation inspected ${git.output?.changedFiles.length ?? 0} changed files; ${typecheck.record.summary}`,
      decisions: [],
      artifacts: [...git.artifacts, ...typecheck.artifacts],
      changedFiles: git.output?.changedFiles ?? [],
      toolCalls: [git.record, typecheck.record],
      modelCalls: [],
      testResults: typecheckStatus ? [`typecheck:${typecheckStatus}`] : [],
      openRisks: risks,
      usage: noUsage
    };
  }
}

export class PlaceholderAgent implements Agent {
  constructor(private readonly reason: string) {}

  async run(task: StageTask): Promise<StageResult> {
    return {
      status: "skipped",
      summary: this.reason,
      decisions: [],
      artifacts: [],
      changedFiles: [],
      toolCalls: [],
      modelCalls: [],
      testResults: [],
      openRisks: [`${task.stage} agent is not implemented in this vertical slice.`],
      usage: noUsage
    };
  }
}
