import { cp, mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ArtifactStore } from "../artifacts/store.js";
import { listModelAliases, type ShadowConfig } from "../config/schema.js";
import type { ModelProvider } from "../models/provider.js";
import { LifecycleOrchestrator, type OrchestratorDependencies } from "../orchestration/orchestrator.js";
import type { Run, ToolCallRecord } from "../orchestration/types.js";
import { openSQLitePersistenceStore } from "../persistence/sqlite-store.js";
import { createDefaultActionRegistry } from "../tools/default-registry.js";
import { executeProcess } from "../tools/process.js";
import { evaluateAcceptance, type AcceptanceEvaluation, type RunFacts } from "./acceptance.js";
import { destructiveChangeRefusal } from "../tools/actions/patch.js";
import { runBaselineTask, selectBaselineModelAlias, type BaselineRunResult } from "./baseline.js";
import {
  BenchmarkFixtureSchema,
  type BenchmarkFixture,
  type BenchmarkTask,
  type GitRepositorySource
} from "./fixture.js";
import { buildShadowObservation } from "./observe.js";
import type { BenchmarkObservation, BenchmarkReportInput, BenchmarkWorkspace } from "./report.js";
import type { ArtifactReference } from "../orchestration/types.js";

const riskyRiskClasses = new Set(["external_write", "destructive"]);

/**
 * Directories a test or build step creates inside the workspace. They are not work the
 * system chose to do, so scoring them as changed files produces false scope failures.
 */
const generatedPathPrefixes = [
  ".shadow/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".pytest_cache/",
  "__pycache__/",
  ".venv/"
];

export const BenchmarkSystemSchema = z.enum(["baseline", "shadow"]);
export type BenchmarkSystem = z.infer<typeof BenchmarkSystemSchema>;

export const BenchmarkExecutionOptionsSchema = z.object({
  benchmarkId: z.string().min(1),
  fixtureDirs: z.array(z.string().min(1)).min(1),
  taskIds: z.array(z.string().min(1)).default([]),
  systems: z.array(BenchmarkSystemSchema).min(1).default(["baseline", "shadow"]),
  benchmarkModel: z.string().min(1).optional(),
  workRoot: z.string().min(1).optional()
});
export type BenchmarkExecutionOptions = z.infer<typeof BenchmarkExecutionOptionsSchema>;

export interface BenchmarkTaskReport {
  fixtureId: string;
  taskId: string;
  system: BenchmarkSystem;
  workspaceRoot: string;
  status: string;
  summary: string;
  acceptance: AcceptanceEvaluation;
  changedFiles: string[];
  artifacts: ArtifactReference[];
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
  const command = ["git", ...args];
  const result = await executeProcess(command, {
    workspaceRoot,
    cwd: workspaceRoot,
    timeoutMs: 60_000,
    maxOutputBytes: 4_000_000,
    signal
  });
  if (result.exitCode !== 0) {
    // Git reports several ordinary failures on stdout, so report both streams.
    const diagnostic = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ");
    throw new Error(
      `${command.join(" ")} exited ${result.exitCode} in ${workspaceRoot}${diagnostic ? `: ${diagnostic}` : ""}`
    );
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
  // Re-running a benchmark must start from the fixture, never from a previous run's
  // output: a leftover tree would either fail to commit or, worse, commit the previous
  // result as the baseline and make the task look like it changed nothing.
  if (!workspaceRoot.startsWith(`${resolve(workRoot)}${sep}`)) {
    throw new Error(`Refusing to provision outside the work root: ${workspaceRoot}`);
  }
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });

  if (typeof fixture.repository === "string") {
    await cp(resolve(fixtureDir, fixture.repository), workspaceRoot, { recursive: true });
  } else {
    await cloneRepositorySource(fixture.repository, fixtureDir, workspaceRoot, signal);
  }

  // The tree is re-initialised as a fresh repository with a single commit either way, so
  // changed files are computable from Git and a cloned repository's own history cannot be
  // mistaken for the system's work.
  await rm(resolve(workspaceRoot, ".git"), { recursive: true, force: true });
  await git(workspaceRoot, ["init", "--quiet"], signal);
  await git(workspaceRoot, ["add", "-A"], signal);
  await git(
    workspaceRoot,
    [
      "-c", "user.email=benchmark@shadow.local",
      "-c", "user.name=Shadow Benchmark",
      "commit", "--quiet", "-m", `fixture ${fixture.id} at ${describeRepository(fixture)}`
    ],
    signal
  );
  return workspaceRoot;
}

/**
 * Clones a fixture's source repository at a pinned revision. `--no-checkout` first so the
 * revision is resolved before any working tree exists, and the clone is never written back
 * to: the source repository is read-only input.
 */
async function cloneRepositorySource(
  repository: GitRepositorySource,
  fixtureDir: string,
  workspaceRoot: string,
  signal: AbortSignal
): Promise<void> {
  // A relative source resolves against the fixture directory, so a fixture that sits
  // beside the repository it evaluates stays portable.
  const source = /^[a-z][a-z0-9+.-]*:\/\//i.test(repository.source) || repository.source.startsWith("git@")
    ? repository.source
    : resolve(fixtureDir, repository.source);

  await git(workspaceRoot, ["init", "--quiet"], signal);
  await git(workspaceRoot, ["remote", "add", "origin", source], signal);
  try {
    await git(workspaceRoot, ["fetch", "--quiet", "--depth", "1", "origin", repository.revision], signal);
  } catch {
    // Shallow fetch of a bare SHA is refused by some servers and by older local repos.
    await git(workspaceRoot, ["fetch", "--quiet", "origin"], signal);
  }
  await git(workspaceRoot, ["checkout", "--quiet", "--force", repository.revision], signal);

  await applyExcludes(workspaceRoot, repository.exclude);
}

/**
 * Removes excluded paths from a provisioned tree. An entry containing a separator is a
 * path relative to the workspace root; a bare name matches anywhere in the tree, because
 * the bulk worth dropping from a real repository — `node_modules`, `__pycache__`, `dist`
 * — is usually nested rather than at the root.
 */
export async function applyExcludes(workspaceRoot: string, excludes: string[]): Promise<void> {
  const names = new Set(excludes.filter((entry) => !entry.includes("/")));
  for (const entry of excludes.filter((candidate) => candidate.includes("/"))) {
    const target = resolve(workspaceRoot, entry);
    if (!target.startsWith(`${workspaceRoot}${sep}`)) {
      throw new Error(`Fixture exclude path escapes the workspace: ${entry}`);
    }
    await rm(target, { recursive: true, force: true });
  }
  if (names.size === 0) return;

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = resolve(directory, entry.name);
      if (names.has(entry.name)) {
        await rm(full, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(workspaceRoot);
}

/** How a provisioned tree identifies itself, for the workspace's own commit message. */
function describeRepository(fixture: BenchmarkFixture): string {
  return typeof fixture.repository === "string"
    ? `revision ${fixture.repositoryRevision}`
    : `${fixture.repository.source}@${fixture.repository.revision}`;
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
    if (generatedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
      continue;
    }
    paths.push(path);
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
    }
  }
  return paths.sort();
}

/** Tool calls the action guards refused for carrying a destructive change. */
function guardRefusals(toolCalls: ToolCallRecord[]): string[] {
  return toolCalls
    .filter((call) => call.summary.includes(destructiveChangeRefusal))
    .map((call) => `${call.actionId}: ${call.summary}`);
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

function uniqueArtifacts(artifacts: readonly ArtifactReference[]): ArtifactReference[] {
  const seen = new Set<string>();
  const unique: ArtifactReference[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.sha256}\0${artifact.kind}\0${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(artifact);
  }
  return unique;
}

function benchmarkWorkspace(report: BenchmarkTaskReport): BenchmarkWorkspace {
  return {
    fixtureId: report.fixtureId,
    taskId: report.taskId,
    system: report.system,
    workspaceRoot: report.workspaceRoot,
    status: report.status,
    summary: report.summary,
    changedFiles: report.changedFiles,
    failedChecks: report.acceptance.checks
      .filter((check) => !check.passed)
      .map((check) => ({ id: check.id, detail: check.detail })),
    artifacts: report.artifacts
  };
}

async function executeShadowTask(
  fixture: BenchmarkFixture,
  task: BenchmarkTask,
  workspaceRoot: string,
  dependencies: BenchmarkExecutionDependencies,
  signal: AbortSignal,
  baselineModel: string
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
    run = await orchestrator.run({
      request: task.request,
      workspaceRoot,
      dryRun: false,
      allowedChangedFiles: task.relevantFiles,
      acceptanceCriteria: task.acceptanceCriteria
    });
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
    unapprovedRiskyActions: unapprovedRiskyActions(toolCalls, approvedOperations),
    refusals: [
      ...run.stageRuns
        .filter((stage) => stage.result?.status === "blocked")
        .map((stage) => stage.result!.summary)
        .filter((summary) => /declined/i.test(summary)),
      ...guardRefusals(toolCalls)
    ]
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
      dangerousOperations: task.dangerousOperations,
      baselineModel
    },
    artifacts
  );
  const runArtifacts = uniqueArtifacts(
    run.stageRuns.flatMap((stage) =>
      stage.attemptResults.flatMap((attempt) => attempt.artifacts)
    )
  );

  return {
    fixtureId: fixture.id,
    taskId: task.id,
    status: run.state,
    summary: run.stageRuns
      .filter((stage) => stage.result)
      .map((stage) => `${stage.stage}: ${stage.result!.summary}`)
      .join(" | "),
    acceptance,
    changedFiles,
    artifacts: runArtifacts,
    observation
  };
}

async function executeBaselineTask(
  fixture: BenchmarkFixture,
  task: BenchmarkTask,
  workspaceRoot: string,
  dependencies: BenchmarkExecutionDependencies,
  signal: AbortSignal,
  benchmarkModel?: string
): Promise<Omit<BenchmarkTaskReport, "system" | "workspaceRoot">> {
  const result: BaselineRunResult = await runBaselineTask({
    request: task.request,
    workspaceRoot,
    config: dependencies.config,
    providers: dependencies.providers,
    taskSpec: {
      acceptanceCriteria: task.acceptanceCriteria,
      relevantFiles: task.relevantFiles,
      permittedSideEffects: task.permittedSideEffects,
      expectedEvidence: task.expectedEvidence,
      safetyAssertions: task.safetyAssertions
    },
    ...(benchmarkModel ? { benchmarkModel } : {}),
    signal
  });

  const changedFiles = await changedFilesFromGit(workspaceRoot, signal);
  const facts: RunFacts = {
    changedFiles,
    // The baseline has no approval gate, so any completed risky action is unapproved.
    unapprovedRiskyActions: unapprovedRiskyActions(result.toolCalls, new Set()),
    // It has no decline path either, but it reaches the same patch guards, so refusing
    // to apply destructive work is evidence it can produce.
    refusals: guardRefusals(result.toolCalls)
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
    modelUsage: result.modelCalls.map((call) => ({
      provider: call.provider,
      model: call.model,
      ...(call.modelAlias ? { modelAlias: call.modelAlias } : {}),
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      totalTokens: call.usage.inputTokens + call.usage.outputTokens,
      estimatedCostUsd: call.usage.estimatedCostUsd
    })),
    latencyMs: result.latencyMs,
    humanInterventions: 0,
    dangerousActionsAttempted: dangerous.attempted,
    dangerousActionsRejected: dangerous.rejected,
    irrelevantFilesLoaded: result.filesLoaded.filter((path) => !relevantFiles.has(path)).length,
    stageCount: 1,
    retries: Math.max(0, result.modelCalls.length - 1),
    testRecoveriesAttempted: 0,
    testRecoveriesSucceeded: 0
  };

  return {
    fixtureId: fixture.id,
    taskId: task.id,
    status: result.status,
    summary: result.summary,
    acceptance,
    changedFiles,
    artifacts: uniqueArtifacts(result.artifacts),
    observation
  };
}

export async function loadBenchmarkFixture(fixtureDir: string): Promise<BenchmarkFixture> {
  const path = resolve(fixtureDir, "fixture.yaml");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`No benchmark fixture at ${path}. Pass a directory containing fixture.yaml.`);
  }
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
  const baselineAlias = selectBaselineModelAlias(dependencies.config, options.benchmarkModel);
  const workRoot = options.workRoot
    ? resolve(options.workRoot)
    : await mkdtemp(join(tmpdir(), "shadow-benchmark-"));
  await mkdir(workRoot, { recursive: true });

  const taskReports: BenchmarkTaskReport[] = [];
  const skipped: BenchmarkSkippedTask[] = [];
  const requestedTasks = new Set(options.taskIds);
  const fixtureRevisions: Record<string, string> = {};

  for (const fixtureDir of options.fixtureDirs) {
    const fixture = await loadBenchmarkFixture(fixtureDir);
    fixtureRevisions[fixture.id] = typeof fixture.repository === "string"
      ? String(fixture.repositoryRevision)
      : `${fixture.repository.source}@${fixture.repository.revision}`;
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
          ? await executeShadowTask(
              fixture,
              task,
              workspaceRoot,
              dependencies,
              signal,
              `${baselineAlias.provider}/${baselineAlias.model}`
            )
          : await executeBaselineTask(
              fixture,
              task,
              workspaceRoot,
              dependencies,
              signal,
              options.benchmarkModel
            );
        taskReports.push({ ...report, system, workspaceRoot });
      }
    }
  }

  // Assembled without the report schema's pairing minimum: a single-system or
  // fully skipped execution is a valid assembly. buildBenchmarkReport still fails
  // closed when the observations are not paired.
  const agentMapping = Object.entries(dependencies.config.agents)
    .map(([stage, alias]) => `${stage}=${alias}`)
    .join(",");
  const input: BenchmarkReportInput = {
    version: 1,
    benchmarkId: options.benchmarkId,
    baselineModel: `${baselineAlias.provider}/${baselineAlias.model}`,
    shadowConfig: agentMapping || "unmapped",
    workRoot,
    workspaces: taskReports.map(benchmarkWorkspace),
    fixtureRevisions,
    modelAliases: Object.fromEntries(
      listModelAliases(dependencies.config).map((alias) => [
        alias.alias,
        `${alias.provider}/${alias.model}${alias.frontier ? " [reserved]" : ""}`
      ])
    ),
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
    if (report.status !== "completed" && report.status !== "COMPLETED" && report.summary) {
      lines.push(`      ${report.summary}`);
    }
    for (const check of acceptance.checks.filter((outcome) => !outcome.passed)) {
      lines.push(`      failed check ${check.id}: ${check.detail}`);
    }
  }
  for (const entry of execution.skipped) {
    lines.push(`  skipped ${entry.fixtureId}/${entry.taskId}: ${entry.reason}`);
  }
  return lines.join("\n");
}
