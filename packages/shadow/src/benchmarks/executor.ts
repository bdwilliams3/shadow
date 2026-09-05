import { cp, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ArtifactStore } from "../artifacts/store.js";
import type { ShadowConfig } from "../config/schema.js";
import type { ModelProvider } from "../models/provider.js";
import { LifecycleOrchestrator, type OrchestratorDependencies } from "../orchestration/orchestrator.js";
import type { Run, ToolCallRecord } from "../orchestration/types.js";
import { openSQLitePersistenceStore } from "../persistence/sqlite-store.js";
import { createDefaultActionRegistry } from "../tools/default-registry.js";
import { executeProcess } from "../tools/process.js";
import { evaluateAcceptance, type AcceptanceEvaluation, type RunFacts } from "./acceptance.js";
import { runBaselineTask, type BaselineRunResult } from "./baseline.js";
import { BenchmarkFixtureSchema, type BenchmarkFixture, type BenchmarkTask } from "./fixture.js";
import { buildShadowObservation } from "./observe.js";
import type { BenchmarkObservation, BenchmarkReportInput } from "./report.js";

const riskyRiskClasses = new Set(["external_write", "destructive"]);

export const BenchmarkSystemSchema = z.enum(["baseline", "shadow"]);
export type BenchmarkSystem = z.infer<typeof BenchmarkSystemSchema>;

export const BenchmarkExecutionOptionsSchema = z.object({
  benchmarkId: z.string().min(1),
  fixtureDirs: z.array(z.string().min(1)).min(1),
  taskIds: z.array(z.string().min(1)).default([]),
  systems: z.array(BenchmarkSystemSchema).min(1).default(["baseline", "shadow"]),
  workRoot: z.string().min(1).optional()
});
export type BenchmarkExecutionOptions = z.infer<typeof BenchmarkExecutionOptionsSchema>;

export interface BenchmarkTaskReport {
  fixtureId: string;
  taskId: string;
  system: BenchmarkSystem;
  workspaceRoot: string;
  status: string;
  acceptance: AcceptanceEvaluation;
  changedFiles: string[];
  observation: BenchmarkObservation;
}

export interface BenchmarkSkippedTask {
  fixtureId: string;
  taskId: string;
  reason: string;
}

export interface BenchmarkExecution {
  input: BenchmarkReportInput;
  taskReports: BenchmarkTaskReport[];
  skipped: BenchmarkSkippedTask[];
  workRoot: string;
}

export interface BenchmarkExecutionDependencies {
  config: ShadowConfig;
  providers: ReadonlyMap<string, ModelProvider>;
  orchestrator?: OrchestratorDependencies;
  signal?: AbortSignal;
}

async function git(workspaceRoot: string, args: string[], signal: AbortSignal): Promise<string> {
  const result = await executeProcess(["git", ...args], {
    workspaceRoot,
    cwd: workspaceRoot,
    timeoutMs: 60_000,
    maxOutputBytes: 4_000_000,
    signal
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in ${workspaceRoot}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Copies the fixture repository into an isolated workspace and commits it, so every
 * task starts from an identical clean tree and changed files are computable from Git.
 */
async function provisionWorkspace(
  fixtureDir: string,
  fixture: BenchmarkFixture,
  task: BenchmarkTask,
  system: BenchmarkSystem,
  workRoot: string,
  signal: AbortSignal
): Promise<string> {
  const workspaceRoot = resolve(workRoot, fixture.id, task.id, system);
  await mkdir(workspaceRoot, { recursive: true });
  await cp(resolve(fixtureDir, fixture.repository), workspaceRoot, { recursive: true });
  await git(workspaceRoot, ["init", "--quiet"], signal);
  await git(workspaceRoot, ["add", "-A"], signal);
  await git(
    workspaceRoot,
    [
      "-c", "user.email=benchmark@shadow.local",
      "-c", "user.name=Shadow Benchmark",
      "commit", "--quiet", "-m", `fixture ${fixture.id} revision ${fixture.repositoryRevision}`
    ],
    signal
  );
  return workspaceRoot;
}

/** Changed files observed in the workspace itself, not as self-reported by the system. */
async function changedFilesFromGit(workspaceRoot: string, signal: AbortSignal): Promise<string[]> {
  const output = await git(
    workspaceRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal
  );
  const fields = output.split("\0").filter((field) => field.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (path.startsWith(".shadow/")) {
      continue;
    }
    paths.push(path);
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
    }
  }
  return paths.sort();
}

function unapprovedRiskyActions(
  toolCalls: readonly ToolCallRecord[],
  approvedOperations: ReadonlySet<string>
): string[] {
  const registry = createDefaultActionRegistry();
  return [
    ...new Set(
      toolCalls
        .filter((call) => call.status === "completed")
        .filter((call) => {
          const definition = registry.get(call.actionId);
          return definition !== undefined && riskyRiskClasses.has(definition.manifest.risk);
        })
        .filter((call) => !approvedOperations.has(call.actionId))
        .map((call) => call.actionId)
    )
  ].sort();
}

function dangerousActionCounts(
  task: BenchmarkTask,
  toolCalls: readonly ToolCallRecord[]
): { attempted: number; rejected: number } {
  const expected = new Set(task.dangerousOperations);
  const matching = toolCalls.filter((call) => expected.has(call.actionId));
  return {
    attempted: matching.length,
    rejected: matching.filter((call) => call.status === "blocked").length
  };
}

async function executeShadowTask(
  fixture: BenchmarkFixture,
  task: BenchmarkTask,
  workspaceRoot: string,
  dependencies: BenchmarkExecutionDependencies,
  signal: AbortSignal
): Promise<Omit<BenchmarkTaskReport, "system" | "workspaceRoot">> {
  const config = dependencies.config;
  const store = await openSQLitePersistenceStore(
    resolve(workspaceRoot, config.persistence.databasePath),
    resolve(workspaceRoot, config.persistence.runsDir)
  );
  let run: Run;
  try {
    const orchestrator = new LifecycleOrchestrator(config, store, {
      providers: dependencies.providers,
      ...dependencies.orchestrator
    });
    run = await orchestrator.run({ request: task.request, workspaceRoot, dryRun: false });
  } finally {
    store.close();
  }

  const toolCalls = run.stageRuns
    .flatMap((stage) => stage.attemptResults)
    .flatMap((attempt) => attempt.toolCalls);
  const approvedOperations = new Set(
    run.approvals.filter((approval) => approval.status === "approved").map((approval) => approval.operation)
  );
  const changedFiles = await changedFilesFromGit(workspaceRoot, signal);
  const facts: RunFacts = {
    changedFiles,
    unapprovedRiskyActions: unapprovedRiskyActions(toolCalls, approvedOperations)
  };
  const acceptance = await evaluateAcceptance(task, workspaceRoot, facts, signal);
  const artifacts = new ArtifactStore(resolve(workspaceRoot, config.persistence.artifactsDir));
  const observation = await buildShadowObservation(
    run,
    {
      fixtureId: fixture.id,
      taskId: task.id,
      acceptanceCriteriaPassed: acceptance.criteriaPassed,
      acceptanceCriteriaTotal: acceptance.criteriaTotal,
      unevaluatedCriteria: acceptance.unevaluatedCriteria,
      relevantFiles: task.relevantFiles,
      dangerousOperations: task.dangerousOperations
    },
    artifacts
  );

  return {
    fixtureId: fixture.id,
    taskId: task.id,
    status: run.state,
    acceptance,
    changedFiles,
    observation
  };
}

async function executeBaselineTask(
  fixture: BenchmarkFixture,
  task: BenchmarkTask,
  workspaceRoot: string,
  dependencies: BenchmarkExecutionDependencies,
  signal: AbortSignal
): Promise<Omit<BenchmarkTaskReport, "system" | "workspaceRoot">> {
  const result: BaselineRunResult = await runBaselineTask({
    request: task.request,
    acceptanceCriteria: task.acceptanceCriteria,
    workspaceRoot,
    config: dependencies.config,
    providers: dependencies.providers,
    signal
  });

  const changedFiles = await changedFilesFromGit(workspaceRoot, signal);
  const facts: RunFacts = {
    changedFiles,
    // The baseline has no approval gate, so any completed risky action is unapproved.
    unapprovedRiskyActions: unapprovedRiskyActions(result.toolCalls, new Set())
  };
  const acceptance = await evaluateAcceptance(task, workspaceRoot, facts, signal);
  const relevantFiles = new Set(task.relevantFiles);
  const dangerous = dangerousActionCounts(task, result.toolCalls);
  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;

  const observation: BenchmarkObservation = {
    system: "baseline",
    fixtureId: fixture.id,
    taskId: task.id,
    succeeded: result.status === "completed" && acceptance.criteriaPassed === acceptance.criteriaTotal,
    acceptanceCriteriaPassed: acceptance.criteriaPassed,
    acceptanceCriteriaTotal: acceptance.criteriaTotal,
    unevaluatedCriteria: acceptance.unevaluatedCriteria,
    frontierTokens: totalTokens,
    totalTokens,
    estimatedCostUsd: result.usage.estimatedCostUsd,
    latencyMs: result.latencyMs,
    humanInterventions: 0,
    dangerousActionsAttempted: dangerous.attempted,
    dangerousActionsRejected: dangerous.rejected,
    irrelevantFilesLoaded: result.filesLoaded.filter((path) => !relevantFiles.has(path)).length,
    stageCount: 1,
    retries: 0,
    testRecoveriesAttempted: 0,
    testRecoveriesSucceeded: 0
  };

  return {
    fixtureId: fixture.id,
    taskId: task.id,
    status: result.status,
    acceptance,
    changedFiles,
    observation
  };
}

export async function loadBenchmarkFixture(fixtureDir: string): Promise<BenchmarkFixture> {
  const source = await readFile(resolve(fixtureDir, "fixture.yaml"), "utf8");
  return BenchmarkFixtureSchema.parse(YAML.parse(source));
}

/**
 * Provisions a clean workspace per fixture task and system, runs each system, scores the
 * deterministic acceptance checks, and assembles paired observations. Full command output
 * stays in workspace artifacts; only counts reach the observations.
 */
export async function executeBenchmark(
  rawOptions: unknown,
  dependencies: BenchmarkExecutionDependencies
): Promise<BenchmarkExecution> {
  const options = BenchmarkExecutionOptionsSchema.parse(rawOptions);
  const signal = dependencies.signal ?? new AbortController().signal;
  const workRoot = options.workRoot
    ? resolve(options.workRoot)
    : await mkdtemp(join(tmpdir(), "shadow-benchmark-"));
  await mkdir(workRoot, { recursive: true });

  const taskReports: BenchmarkTaskReport[] = [];
  const skipped: BenchmarkSkippedTask[] = [];
  const requestedTasks = new Set(options.taskIds);

  for (const fixtureDir of options.fixtureDirs) {
    const fixture = await loadBenchmarkFixture(fixtureDir);
    for (const task of fixture.tasks) {
      if (requestedTasks.size > 0 && !requestedTasks.has(task.id)) {
        continue;
      }
      if (task.acceptanceChecks.length === 0) {
        skipped.push({
          fixtureId: fixture.id,
          taskId: task.id,
          reason: "task declares no deterministic acceptance checks and cannot be scored"
        });
        continue;
      }

      for (const system of options.systems) {
        const workspaceRoot = await provisionWorkspace(
          fixtureDir,
          fixture,
          task,
          system,
          workRoot,
          signal
        );
        const report = system === "shadow"
          ? await executeShadowTask(fixture, task, workspaceRoot, dependencies, signal)
          : await executeBaselineTask(fixture, task, workspaceRoot, dependencies, signal);
        taskReports.push({ ...report, system, workspaceRoot });
      }
    }
  }

  // Assembled without the report schema's pairing minimum: a single-system or
  // fully skipped execution is a valid assembly. buildBenchmarkReport still fails
  // closed when the observations are not paired.
  const agentMapping = Object.entries(dependencies.config.agents)
    .map(([stage, tier]) => `${stage}=${tier}`)
    .join(",");
  const input: BenchmarkReportInput = {
    version: 1,
    benchmarkId: options.benchmarkId,
    baselineModel: `${dependencies.config.models.frontier.provider}/${dependencies.config.models.frontier.model}`,
    shadowConfig: agentMapping || "unmapped",
    observations: taskReports.map((report) => report.observation)
  };

  return { input, taskReports, skipped, workRoot };
}

export function formatBenchmarkExecution(execution: BenchmarkExecution): string {
  const lines = [
    `Benchmark ${execution.input.benchmarkId}`,
    `Workspaces: ${execution.workRoot}`,
    `Observations: ${execution.input.observations.length}`
  ];
  for (const report of execution.taskReports) {
    const { acceptance } = report;
    lines.push(
      `  ${report.system.padEnd(8)} ${report.fixtureId}/${report.taskId}: ${report.status}, ` +
        `criteria ${acceptance.criteriaPassed}/${acceptance.criteriaTotal}` +
        (acceptance.unevaluatedCriteria > 0 ? ` (${acceptance.unevaluatedCriteria} unevaluated)` : "")
    );
    for (const check of acceptance.checks.filter((outcome) => !outcome.passed)) {
      lines.push(`      failed check ${check.id}: ${check.detail}`);
    }
  }
  for (const entry of execution.skipped) {
    lines.push(`  skipped ${entry.fixtureId}/${entry.taskId}: ${entry.reason}`);
  }
  return lines.join("\n");
}
