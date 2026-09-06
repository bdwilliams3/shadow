import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DevelopAgent, TestAgent, ValidateAgent } from "../agents/basic-agents.js";
import { PlanAgent } from "../agents/plan-agent.js";
import { DeployAgent } from "../agents/deploy-agent.js";
import { DesignAgent } from "../agents/design-agent.js";
import { DocumentAgent } from "../agents/document-agent.js";
import type { Agent } from "../agents/contract.js";
import { ArtifactStore } from "../artifacts/store.js";
import type { ShadowConfig } from "../config/schema.js";
import { createConfiguredProviders } from "../models/factory.js";
import {
  createConfiguredTestsExecutor,
  type TestsExecutor
} from "../mcp/tests/client.js";
import type { ModelProvider } from "../models/provider.js";
import { ModelRouter } from "../models/router.js";
import type { PersistenceStore } from "../persistence/store.js";
import { createDefaultActionRegistry } from "../tools/default-registry.js";
import { ActionRunner } from "../tools/runner.js";
import { addUsage } from "./budget.js";
import { createStageTask, planWorkflow } from "./planner.js";
import { assertTransition, stateForStage } from "./state-machine.js";
import type {
  ApprovalRecord,
  CapabilityTier,
  PlanRevision,
  Run,
  RunState,
  StageName,
  StageResult,
  StageRun,
  StageTask
} from "./types.js";
import { stageOrder } from "./types.js";

export interface RunRequest {
  request: string;
  workspaceRoot: string;
  dryRun: boolean;
}

export interface OrchestratorDependencies {
  providers?: ReadonlyMap<string, ModelProvider>;
  testsExecutor?: TestsExecutor;
  cancellationPollMs?: number;
}

interface ApprovalTarget {
  operation: string;
  reasons: string[];
}

export class LifecycleOrchestrator {
  constructor(
    private readonly config: ShadowConfig,
    private readonly store: PersistenceStore,
    private readonly dependencies: OrchestratorDependencies = {}
  ) {}

  async run(input: RunRequest): Promise<Run> {
    const now = new Date().toISOString();
    let run: Run = {
      id: randomUUID(),
      workspaceRoot: resolve(input.workspaceRoot),
      request: input.request,
      state: "RECEIVED",
      dryRun: input.dryRun,
      createdAt: now,
      updatedAt: now,
      stageTasks: [],
      stageRuns: [],
      approvals: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0
      },
      openRisks: []
    };

    await this.store.createRun(run);
    run = await this.transition(run, "CLASSIFIED", { requestLength: input.request.length });

    const planned = planWorkflow(run.id, input.request, this.config, input.dryRun);
    run.openRisks = planned.risks;
    run.stageTasks = planned.stages;
    run.stageRuns = planned.stages.map<StageRun>((task) => ({
      id: task.id,
      runId: run.id,
      stage: task.stage,
      status: "pending",
      modelTier: this.config.agents[task.stage],
      attempts: 0,
      attemptResults: []
    }));
    run = await this.transition(run, "PLANNED", {
      stages: planned.stages.map((stage) => stage.stage),
      invariants: planned.invariants
    });

    return this.execute(run);
  }

  async resume(runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} was not found.`);
    }
    if (run.state === "COMPLETED" || run.state === "CANCELLED" || run.state === "FAILED") {
      throw new Error(`Run ${runId} cannot resume from terminal state ${run.state}.`);
    }
    if (run.stageTasks.length === 0) {
      throw new Error(`Run ${runId} predates durable stage tasks and cannot be resumed safely.`);
    }
    const approvedReasons = new Set(
      run.approvals
        .filter((approval) => approval.status === "approved")
        .flatMap((approval) => approval.reasons)
    );
    run.openRisks = run.openRisks.filter((risk) => !approvedReasons.has(risk));
    await this.store.appendEvent(run.id, "run.resumed", { state: run.state });
    return this.execute(run);
  }

  private createAgents(workspaceRoot: string, signal: AbortSignal): Record<StageName, Agent> {
    const artifactStore = new ArtifactStore(resolve(workspaceRoot, this.config.persistence.artifactsDir));
    const actions = new ActionRunner(
      createDefaultActionRegistry(),
      workspaceRoot,
      this.config,
      artifactStore,
      signal
    );
    const providers = this.dependencies.providers ?? createConfiguredProviders(this.config).providers;
    const models = new ModelRouter(this.config, providers);
    const tests = this.dependencies.testsExecutor ?? createConfiguredTestsExecutor(this.config, workspaceRoot);
    return {
      plan: new PlanAgent(
        actions,
        models,
        artifactStore,
        this.config.agents.plan,
        this.config.lifecycle.enabledStages,
        this.config.persistence.databasePath,
        this.config.workspace.exclusions
      ),
      design: new DesignAgent(
        actions,
        models,
        artifactStore,
        this.config.agents.design,
        this.config.persistence.databasePath,
        this.config.workspace.exclusions
      ),
      develop: new DevelopAgent(
        actions,
        models,
        artifactStore,
        this.config.agents.develop,
        this.config.persistence.databasePath,
        this.config.workspace.exclusions
      ),
      test: new TestAgent(
        actions,
        tests,
        this.config.persistence.databasePath,
        this.config.workspace.exclusions
      ),
      validate: new ValidateAgent(actions, this.config.workspace.exclusions),
      deploy: new DeployAgent(actions, artifactStore, this.config.deployment),
      document: new DocumentAgent(
        actions,
        models,
        artifactStore,
        this.config.agents.document,
        this.config.persistence.databasePath,
        this.config.workspace.exclusions
      )
    };
  }

  private async execute(initialRun: Run): Promise<Run> {
    let run = initialRun;
    const cancellation = new AbortController();
    const agents = this.createAgents(run.workspaceRoot, cancellation.signal);
    const monitor = setInterval(() => {
      void this.store.getRun(run.id).then((persisted) => {
        if (persisted?.state === "CANCELLED") {
          cancellation.abort();
        }
      }).catch(() => undefined);
    }, this.dependencies.cancellationPollMs ?? 200);
    monitor.unref();

    try {
      const artifactStore = new ArtifactStore(
        resolve(run.workspaceRoot, this.config.persistence.artifactsDir)
      );
      const cycleStart = new Map<string, number>();
      let remediationCycles = 0;
      let index = 0;
      stageLoop: while (index < run.stageTasks.length) {
        const task = run.stageTasks[index] as StageTask;
        const persisted = await this.store.getRun(run.id);
        if (persisted?.state === "CANCELLED") {
          return persisted;
        }
        if (persisted) {
          run = persisted;
        }

        const stageRun = this.stageRunFor(run, task);
        if (stageRun.status === "completed" || stageRun.status === "skipped") {
          index += 1;
          continue;
        }
        if (
          stageRun.status === "blocked" &&
          run.approvals.some((approval) => approval.stageTaskId === task.id && approval.status === "pending")
        ) {
          return run;
        }

        const approvedOperations = run.approvals
          .filter((approval) => approval.stageTaskId === task.id && approval.status === "approved")
          .map((approval) => approval.operation);
        // Retry and model-call budgets are scoped to the current remediation cycle so a
        // remediation pass is not immediately blocked by the attempts that triggered it.
        const attemptsBefore = cycleStart.get(task.id) ?? 0;
        let failedAttempts = stageRun.attemptResults
          .slice(attemptsBefore)
          .filter((result) => result.status === "failed").length;

        while (true) {
          const modelCalls = stageRun.attemptResults
            .slice(attemptsBefore)
            .reduce(
              (count, result) =>
                count + result.modelCalls.filter((call) => call.status !== "blocked").length,
              0
            );
          if (
            failedAttempts > this.config.lifecycle.maxStageRetries ||
            modelCalls >= this.config.lifecycle.maxModelCallsPerStage
          ) {
            const developIndex = await this.planRemediation(
              run,
              task,
              index,
              stageRun.result,
              "retry or model-call limit reached",
              remediationCycles,
              cycleStart,
              artifactStore
            );
            if (developIndex !== undefined) {
              remediationCycles += 1;
              index = developIndex;
              continue stageLoop;
            }
            return this.transition(run, "FAILED", {
              stage: task.stage,
              reason: "retry or model-call limit reached"
            });
          }

          const nextState = stateForStage(task.stage);
          run = await this.transition(run, nextState, { stage: task.stage });
          if (run.state === "CANCELLED") {
            return run;
          }
          const activeStageRun = this.stageRunFor(run, task);
          activeStageRun.status = "running";
          activeStageRun.attempts += 1;
          activeStageRun.startedAt = new Date().toISOString();
          delete activeStageRun.completedAt;
          await this.store.updateRun(this.touch(run));
          await this.store.appendEvent(run.id, "stage.started", {
            stage: task.stage,
            attempt: activeStageRun.attempts,
            modelTier: activeStageRun.modelTier
          });

          const priorArtifacts = run.stageRuns
            .slice(0, run.stageRuns.findIndex((candidate) => candidate.id === task.id))
            .flatMap((candidate) => candidate.result?.artifacts ?? []);
          const currentStageArtifacts = activeStageRun.attemptResults.flatMap(
            (attempt) => attempt.artifacts
          );
          const attemptTask: StageTask = {
            ...task,
            inputs: [...new Map(
              [...task.inputs, ...priorArtifacts, ...currentStageArtifacts].map(
                (artifact) => [artifact.id, artifact]
              )
            ).values()],
            retryCount: failedAttempts
          };
          const stageUsage = activeStageRun.attemptResults.reduce(
            (usage, attempt) => addUsage(usage, attempt.usage),
            { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
          );
          const result = await agents[task.stage].run(attemptTask, {
            workspaceRoot: run.workspaceRoot,
            request: run.request,
            dryRun: run.dryRun,
            stageUsage,
            runBudget: this.config.budgets.run,
            runUsage: run.usage,
            approvedOperations,
            signal: cancellation.signal
          });
          this.recordResult(run, activeStageRun, result);
          await this.recordResultEvents(run, task, activeStageRun, result);

          const latest = await this.store.getRun(run.id);
          if (latest?.state === "CANCELLED" || cancellation.signal.aborted) {
            activeStageRun.status = "cancelled";
            activeStageRun.completedAt = new Date().toISOString();
            run.state = "CANCELLED";
            run.cancellationRequestedAt = latest?.cancellationRequestedAt ?? new Date().toISOString();
            await this.store.updateRun(this.touch(run));
            await this.store.appendEvent(run.id, "stage.cancelled", { stage: task.stage });
            return run;
          }

          if (result.status === "completed" && result.planRevision) {
            await this.applyPlanRevision(run, result.planRevision, index);
          }
          if (result.status === "completed" || result.status === "skipped") {
            break;
          }
          if (result.status === "blocked") {
            const target = this.approvalTarget(result);
            if (target) {
              const existingApproval = run.approvals.find(
                (approval) => approval.stageTaskId === task.id && approval.operation === target.operation
              );
              if (existingApproval?.status === "approved") {
                return this.transition(run, "FAILED", {
                  stage: task.stage,
                  reason: `Approved operation ${target.operation} remained blocked.`
                });
              }
              if (!existingApproval) {
                const approval: ApprovalRecord = {
                  id: randomUUID(),
                  runId: run.id,
                  stageTaskId: task.id,
                  stage: task.stage,
                  operation: target.operation,
                  reasons: target.reasons,
                  status: "pending",
                  createdAt: new Date().toISOString()
                };
                run.approvals.push(approval);
                await this.store.appendEvent(run.id, "approval.requested", {
                  approvalId: approval.id,
                  stage: approval.stage,
                  operation: approval.operation,
                  reasons: approval.reasons
                });
              }
              return this.transition(run, "AWAITING_APPROVAL", {
                stage: task.stage,
                operation: target.operation
              });
            }
            return this.transition(run, "FAILED", { stage: task.stage, reason: result.summary });
          }
          if (result.status === "failed") {
            failedAttempts += 1;
            const modelCallCount = activeStageRun.attemptResults.reduce(
              (count, attempt) =>
                count + attempt.modelCalls.filter((call) => call.status !== "blocked").length,
              0
            );
            if (
              failedAttempts <= this.config.lifecycle.maxStageRetries &&
              modelCallCount < this.config.lifecycle.maxModelCallsPerStage
            ) {
              activeStageRun.status = "pending";
              await this.store.appendEvent(run.id, "stage.retrying", {
                stage: task.stage,
                retryCount: failedAttempts,
                reason: result.summary
              });
              await this.store.updateRun(this.touch(run));
              continue;
            }
            const developIndex = await this.planRemediation(
              run,
              task,
              index,
              result,
              result.summary,
              remediationCycles,
              cycleStart,
              artifactStore
            );
            if (developIndex !== undefined) {
              remediationCycles += 1;
              index = developIndex;
              continue stageLoop;
            }
            return this.transition(run, "FAILED", { stage: task.stage, reason: result.summary });
          }
          return this.transition(run, "FAILED", {
            stage: task.stage,
            reason: `agent returned non-terminal status ${result.status}`
          });
        }

        index += 1;
      }

      return this.transition(run, "COMPLETED", {});
    } finally {
      clearInterval(monitor);
    }
  }

  /**
   * Applies a Plan stage's revision to the part of the lifecycle graph that has not run.
   *
   * The revision is a proposal, not an instruction. Everything that governs cost or blast
   * radius stays with configuration and the stage table: enablement, canonical ordering,
   * allowed tools, write permissions, and the ceiling on capability tier. What the plan
   * genuinely decides is which stages run and what done means for each.
   *
   * Stages at or before `currentIndex` have already executed and are never touched, so a
   * revision cannot rewrite history or re-run completed work. Surviving stages keep their
   * task id, which keeps resume, approvals, and remediation cycle bookkeeping coherent.
   */
  private async applyPlanRevision(
    run: Run,
    revision: PlanRevision,
    currentIndex: number
  ): Promise<void> {
    const prefix = run.stageTasks.slice(0, currentIndex + 1);
    const executed = new Set(prefix.map((task) => task.stage));
    const suffix = run.stageTasks.slice(currentIndex + 1);
    const before = suffix.map((task) => task.stage);

    const enabled = new Set(this.config.lifecycle.enabledStages);
    const requested = [...new Set(revision.stages)]
      .filter((stage) => enabled.has(stage) && !executed.has(stage))
      .sort((left, right) => stageOrder.indexOf(left) - stageOrder.indexOf(right));

    const rejectedStages = [...new Set(revision.stages)].filter(
      (stage) => !enabled.has(stage) && !executed.has(stage)
    );

    if (requested.length === 0) {
      // A revision that leaves nothing to do is not actionable; keep the bootstrap graph.
      run.openRisks = [
        ...new Set([
          ...run.openRisks,
          "Plan proposed no runnable stages; the deterministic stage graph was kept."
        ])
      ];
      await this.store.updateRun(this.touch(run));
      return;
    }

    const plannedByStage = new Map(revision.tasks.map((task) => [task.stage, task]));
    const reusableByStage = new Map(suffix.map((task) => [task.stage, task]));
    const risks: string[] = [];

    const revisedTasks = requested.map((stage) => {
      const planned = plannedByStage.get(stage);
      const existing = reusableByStage.get(stage);
      const task = createStageTask({
        runId: run.id,
        stage,
        goal: planned?.goal ?? run.request,
        budget: this.config.budgets.stage,
        dryRun: run.dryRun,
        acceptanceCriteria: planned?.acceptanceCriteria ?? [],
        ...(existing ? { id: existing.id } : {})
      });
      // Artifacts already routed to a surviving task (a remediation failure, say) outlive
      // the revision.
      task.inputs = existing?.inputs ?? [];
      return task;
    });

    const revisedRuns = revisedTasks.map<StageRun>((task) => {
      const existing = run.stageRuns.find((candidate) => candidate.id === task.id);
      const configured = this.config.agents[task.stage];
      const recommended = plannedByStage.get(task.stage)?.recommendedTier;
      const tier = this.clampTier(task.stage, configured, recommended, risks);
      return existing
        ? { ...existing, stage: task.stage, modelTier: tier }
        : {
            id: task.id,
            runId: run.id,
            stage: task.stage,
            status: "pending",
            modelTier: tier,
            attempts: 0,
            attemptResults: []
          };
    });

    run.stageTasks = [...prefix, ...revisedTasks];
    run.stageRuns = [
      ...run.stageRuns.filter((candidate) => prefix.some((task) => task.id === candidate.id)),
      ...revisedRuns
    ];
    if (rejectedStages.length > 0) {
      risks.push(
        `Plan proposed stages disabled by configuration: ${rejectedStages.join(", ")}.`
      );
    }
    risks.push(...revision.risks);
    run.openRisks = [...new Set([...run.openRisks, ...risks])];

    await this.store.updateRun(this.touch(run));
    await this.store.appendEvent(run.id, "run.replanned", {
      before,
      after: requested,
      acceptanceCriteria: Object.fromEntries(
        revisedTasks
          .filter((task) => task.acceptanceCriteria.length > 0)
          .map((task) => [task.stage, task.acceptanceCriteria])
      ),
      modelTiers: Object.fromEntries(revisedRuns.map((entry) => [entry.stage, entry.modelTier]))
    });
  }

  /**
   * Configuration is the authority on spend. A plan may ask for a cheaper tier than the
   * one configured for a stage and get it; asking for a more capable one is recorded as a
   * risk and refused, so no model can quietly escalate a run's cost.
   */
  private clampTier(
    stage: StageName,
    configured: CapabilityTier,
    recommended: CapabilityTier | undefined,
    risks: string[]
  ): CapabilityTier {
    if (!recommended || recommended === configured) {
      return configured;
    }
    const capability: Record<CapabilityTier, number> = { economy: 0, balanced: 1, frontier: 2 };
    if (capability[recommended] < capability[configured]) {
      return recommended;
    }
    risks.push(
      `Plan recommended the ${recommended} tier for ${stage}; configuration caps it at ` +
        `${configured} and the recommendation was not applied.`
    );
    return configured;
  }

  /**
   * Routes a terminal Test or Validate failure back into a bounded Develop remediation
   * pass. The failure reaches Develop as a compact artifact — summaries, normalized
   * failures, and open risks — never the raw command output those risks were derived
   * from. Returns the stage index to resume from, or undefined when no remediation is
   * available.
   */
  private async planRemediation(
    run: Run,
    task: StageTask,
    stageIndex: number,
    result: StageResult | undefined,
    reason: string,
    remediationCycles: number,
    cycleStart: Map<string, number>,
    artifacts: ArtifactStore
  ): Promise<number | undefined> {
    if (task.stage !== "test" && task.stage !== "validate") {
      return undefined;
    }
    if (run.dryRun || remediationCycles >= this.config.lifecycle.maxRemediationCycles) {
      return undefined;
    }
    const developIndex = run.stageTasks.findIndex(
      (candidate, candidateIndex) => candidate.stage === "develop" && candidateIndex < stageIndex
    );
    if (developIndex < 0) {
      return undefined;
    }
    const developTask = run.stageTasks[developIndex] as StageTask;
    const developRun = this.stageRunFor(run, developTask);
    if (!developRun.result || developRun.result.status !== "completed") {
      return undefined;
    }

    const failure = {
      stage: task.stage,
      reason,
      summary: result?.summary ?? reason,
      failures: result?.openRisks ?? [],
      testResults: result?.testResults ?? [],
      changedFiles: result?.changedFiles ?? [],
      toolSummaries: (result?.toolCalls ?? [])
        .filter((call) => call.status === "failed")
        .map((call) => ({ actionId: call.actionId, summary: call.summary }))
    };
    const artifact = await artifacts.writeText(
      "remediation.failure",
      `${task.stage}.failure.json`,
      `${JSON.stringify(failure, null, 2)}\n`
    );

    developTask.inputs = [...developTask.inputs, artifact];
    for (let candidate = developIndex; candidate <= stageIndex; candidate += 1) {
      const candidateTask = run.stageTasks[candidate] as StageTask;
      const candidateRun = this.stageRunFor(run, candidateTask);
      cycleStart.set(candidateTask.id, candidateRun.attemptResults.length);
      candidateRun.status = "pending";
      delete candidateRun.completedAt;
    }

    await this.store.updateRun(this.touch(run));
    await this.store.appendEvent(run.id, "run.remediation_started", {
      failedStage: task.stage,
      reason,
      cycle: remediationCycles + 1,
      artifactId: artifact.id,
      resumeStage: developTask.stage
    });
    return developIndex;
  }

  private recordResult(run: Run, stageRun: StageRun, result: StageResult): void {
    if (result.status === "completed" || result.status === "skipped") {
      const previousAttemptRisks = new Set(
        stageRun.attemptResults.flatMap((attempt) => attempt.openRisks)
      );
      run.openRisks = run.openRisks.filter((risk) => !previousAttemptRisks.has(risk));
    }
    stageRun.status = result.status;
    stageRun.completedAt = new Date().toISOString();
    stageRun.result = result;
    stageRun.attemptResults.push(result);
    run.usage = addUsage(run.usage, result.usage);
    run.openRisks = [...new Set([...run.openRisks, ...result.openRisks])];
  }

  private async recordResultEvents(
    run: Run,
    task: StageTask,
    stageRun: StageRun,
    result: StageResult
  ): Promise<void> {
    for (const toolCall of result.toolCalls) {
      await this.store.appendEvent(run.id, "tool.completed", toolCall);
    }
    for (const modelCall of result.modelCalls) {
      await this.store.appendEvent(run.id, "model.completed", modelCall);
    }
    await this.store.appendEvent(run.id, "stage.completed", {
      stage: task.stage,
      attempt: stageRun.attempts,
      status: result.status,
      summary: result.summary
    });
    await this.store.updateRun(this.touch(run));
  }

  private approvalTarget(result: StageResult): ApprovalTarget | undefined {
    const toolCall = result.toolCalls.find((call) => call.approvalRequired);
    if (toolCall) {
      return { operation: toolCall.actionId, reasons: [toolCall.summary] };
    }
    const modelCall = result.modelCalls.find((call) => call.approvalRequired);
    if (modelCall) {
      return {
        operation: "model.complete",
        reasons: [modelCall.reason ?? "Model provider network access requires approval."]
      };
    }
    return undefined;
  }

  private stageRunFor(run: Run, task: StageTask): StageRun {
    const stageRun = run.stageRuns.find((candidate) => candidate.id === task.id);
    if (!stageRun) {
      throw new Error(`Missing stage run for task ${task.id}`);
    }
    return stageRun;
  }

  private async transition(run: Run, to: RunState, payload: Record<string, unknown>): Promise<Run> {
    assertTransition(run.state, to);
    const from = run.state;
    run.state = to;
    await this.store.appendEvent(run.id, "run.transition", { from, to, ...payload });
    await this.store.updateRun(this.touch(run));
    return run;
  }

  private touch(run: Run): Run {
    run.updatedAt = new Date().toISOString();
    return run;
  }
}
