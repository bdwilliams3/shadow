#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, relative, resolve } from "node:path";
import { Command } from "commander";
import { ArtifactStore } from "../artifacts/store.js";
import { executeBenchmark, formatBenchmarkExecution } from "../benchmarks/executor.js";
import { buildShadowObservation } from "../benchmarks/observe.js";
import {
  buildBenchmarkReport,
  buildBenchmarkSummary,
  formatBenchmarkReport,
  formatBenchmarkSummary
} from "../benchmarks/report.js";
import { ChatOrchestratorAgent } from "../agents/chat-orchestrator-agent.js";
import { loadConfig, renderDefaultConfig, renderDefaultPolicy } from "../config/load.js";
import { createConfiguredTestsExecutor } from "../mcp/tests/client.js";
import { createConfiguredProviders } from "../models/factory.js";
import { ModelRouter } from "../models/router.js";
import type { ShadowConfig } from "../config/schema.js";
import { probeModels } from "../models/probe.js";
import { LifecycleOrchestrator } from "../orchestration/orchestrator.js";
import type { Run } from "../orchestration/types.js";
import { openSQLitePersistenceStore, type SQLitePersistenceStore } from "../persistence/sqlite-store.js";
import type { PersistenceStore } from "../persistence/store.js";
import { createDefaultActionRegistry } from "../tools/default-registry.js";
import {
  formatProgressEvent,
  formatRunBudget,
  formatRunChangedFiles,
  formatRunPlan,
  formatRunSummary,
  formatStageModelMap
} from "./format.js";
import { parseInteractiveInput } from "./interactive.js";
import type { RunEvent } from "../orchestration/types.js";

interface RunRequestOptions {
  dryRun?: boolean;
  json?: boolean;
  onRunCreated?: (run: Run) => void;
  onEvent?: (event: RunEvent) => void;
}

class ObservingStore implements PersistenceStore {
  constructor(
    private readonly delegate: SQLitePersistenceStore,
    private readonly hooks: Pick<RunRequestOptions, "onRunCreated" | "onEvent">
  ) {}

  async createRun(run: Run): Promise<void> {
    await this.delegate.createRun(run);
    this.hooks.onRunCreated?.(run);
  }

  updateRun(run: Run): Promise<void> {
    return this.delegate.updateRun(run);
  }

  getRun(runId: string): Promise<Run | undefined> {
    return this.delegate.getRun(runId);
  }

  listRuns(): Promise<Run[]> {
    return this.delegate.listRuns();
  }

  listEvents(runId: string): Promise<RunEvent[]> {
    return this.delegate.listEvents(runId);
  }

  async appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<RunEvent> {
    const event = await this.delegate.appendEvent(runId, type, payload);
    this.hooks.onEvent?.(event);
    return event;
  }

  requestCancellation(runId: string): Promise<Run | undefined> {
    return this.delegate.requestCancellation(runId);
  }

  resolveApproval(
    runId: string,
    approvalId: string | undefined,
    decision: "approved" | "rejected"
  ): Promise<Run | undefined> {
    return this.delegate.resolveApproval(runId, approvalId, decision);
  }
}

async function buildStore(workspaceRoot: string): Promise<SQLitePersistenceStore> {
  const { config } = await loadConfig(workspaceRoot);
  return openSQLitePersistenceStore(
    resolve(workspaceRoot, config.persistence.databasePath),
    resolve(workspaceRoot, config.persistence.runsDir)
  );
}

function exitCodeForRun(run: Run): void {
  // Non-interactive invocations must be usable as a gate: a failed or cancelled run
  // exits non-zero. The interactive loop deliberately does not set this.
  if (run.state === "FAILED" || run.state === "CANCELLED") {
    process.exitCode = 1;
  }
}

async function runRequest(request: string, options: RunRequestOptions): Promise<Run> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  const sqliteStore = await openSQLitePersistenceStore(
    resolve(workspaceRoot, config.persistence.databasePath),
    resolve(workspaceRoot, config.persistence.runsDir)
  );
  const store: PersistenceStore =
    options.onRunCreated || options.onEvent
      ? new ObservingStore(sqliteStore, options)
      : sqliteStore;
  try {
    const orchestrator = new LifecycleOrchestrator(config, store);
    const run = await orchestrator.run({
      request,
      workspaceRoot,
      dryRun: options.dryRun ?? false
    });

    if (options.json) {
      console.log(JSON.stringify(run, null, 2));
      return run;
    }
    console.log(formatRunSummary(run));
    return run;
  } finally {
    sqliteStore.close();
  }
}

async function resumeRun(runId: string, options: { json?: boolean }): Promise<Run> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  const store = await openSQLitePersistenceStore(
    resolve(workspaceRoot, config.persistence.databasePath),
    resolve(workspaceRoot, config.persistence.runsDir)
  );
  try {
    const run = await new LifecycleOrchestrator(config, store).resume(runId);
    console.log(options.json ? JSON.stringify(run, null, 2) : formatRunSummary(run));
    return run;
  } finally {
    store.close();
  }
}

async function cancelRun(runId: string): Promise<void> {
  const store = await buildStore(process.cwd());
  try {
    const run = await store.requestCancellation(runId);
    console.log(run ? `Run ${run.id} is ${run.state}.` : `Run ${runId} was not found.`);
  } finally {
    store.close();
  }
}

async function resolveRunApproval(
  decision: "approved" | "rejected",
  runId: string,
  approvalId?: string
): Promise<boolean> {
  const store = await buildStore(process.cwd());
  try {
    const current = await store.getRun(runId);
    if (!current) {
      console.log(`Run ${runId} was not found.`);
      return false;
    }
    const approval = approvalId
      ? current.approvals.find((candidate) => candidate.id === approvalId && candidate.status === "pending")
      : current.approvals.find((candidate) => candidate.status === "pending");
    if (!approval) {
      console.log(`No matching pending approval was found for run ${runId}.`);
      return false;
    }
    await store.resolveApproval(runId, approval.id, decision);
    console.log(`${decision === "approved" ? "Approved" : "Rejected"} ${approval.operation} for run ${runId}.`);
    if (decision === "approved") {
      console.log(`Resume with: shadow resume ${runId}`);
    }
    return true;
  } finally {
    store.close();
  }
}

async function initConfig(): Promise<void> {
  const configPath = resolve(process.cwd(), ".shadow/config.yaml");
  const policyPath = resolve(process.cwd(), ".shadow/policy.yaml");
  await mkdir(dirname(configPath), { recursive: true });

  if (!existsSync(configPath)) {
    await writeFile(configPath, renderDefaultConfig(), "utf8");
    console.log(`Created ${configPath}`);
  } else {
    console.log(`Exists ${configPath}`);
  }

  if (!existsSync(policyPath)) {
    await writeFile(policyPath, renderDefaultPolicy(), "utf8");
    console.log(`Created ${policyPath}`);
  } else {
    console.log(`Exists ${policyPath}`);
  }
}

async function showStatus(runId?: string): Promise<void> {
  const workspaceRoot = process.cwd();
  const store = await buildStore(workspaceRoot);
  try {
    const run = runId ? await store.getRun(runId) : (await store.listRuns())[0];
    if (!run) {
      console.log("No runs found.");
      return;
    }
    console.log(formatRunSummary(run));
  } finally {
    store.close();
  }
}

async function showModels(): Promise<void> {
  const workspaceRoot = process.cwd();
  const { config, sources } = await loadConfig(workspaceRoot);
  const configSummary = sources.length > 0
    ? sources.map((source) => relative(workspaceRoot, source) || source).join(", ")
    : "defaults";
  console.log(`Config: ${configSummary}`);
  console.log(formatStageModelMap(config));
}

async function showActions(options: { json?: boolean }): Promise<void> {
  const actions = createDefaultActionRegistry().list();
  if (options.json) {
    console.log(JSON.stringify(actions, null, 2));
    return;
  }
  for (const action of actions) {
    const effects = [
      action.risk,
      action.network ? "network" : undefined,
      action.writesWorkspace && action.risk !== "workspace_write" ? "workspace-write" : undefined
    ].filter(Boolean);
    console.log(`${action.id}@${action.version} [${effects.join(", ")}] ${action.description}`);
  }
}

async function showMcpServers(): Promise<void> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  if (!config.mcp.tests.enabled) {
    console.log("tests: disabled");
    return;
  }
  const tests = createConfiguredTestsExecutor(config, workspaceRoot);
  if (!tests) {
    console.log("tests: unavailable (the bundled server has not been built)");
    return;
  }
  try {
    const health = await tests.inspect();
    console.log(
      `tests: healthy (${health.serverName}@${health.serverVersion})\n  ${health.tools.join(", ")}`
    );
  } catch (error) {
    console.log(`tests: unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function validateConfig(): Promise<void> {
  const { config, sources } = await loadConfig(process.cwd());
  console.log(`Configuration is valid. Sources: ${sources.length > 0 ? sources.join(", ") : "defaults"}`);
  console.log(`Enabled stages: ${config.lifecycle.enabledStages.join(", ")}`);
}

async function runBenchmark(
  fixtureDirs: string[],
  options: {
    benchmarkId: string;
    task?: string[];
    system?: string[];
    benchmarkModel?: string;
    workRoot?: string;
    out?: string;
    report?: boolean;
    json?: boolean;
  }
): Promise<void> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  const { providers, diagnostics } = createConfiguredProviders(config);
  for (const diagnostic of diagnostics) {
    console.error(diagnostic);
  }

  if (options.workRoot) {
    const workRoot = resolve(workspaceRoot, options.workRoot);
    if (workRoot === workspaceRoot || workRoot.startsWith(`${workspaceRoot}/`)) {
      console.error(
        `Warning: ${workRoot} is inside the current project. Provisioned workspaces will ` +
          "resolve node_modules and tooling from it, so results are not hermetic and may " +
          "not reproduce elsewhere. Prefer a work root outside the project."
      );
    }
  }

  const execution = await executeBenchmark(
    {
      benchmarkId: options.benchmarkId,
      fixtureDirs: fixtureDirs.map((dir) => resolve(workspaceRoot, dir)),
      taskIds: options.task ?? [],
      systems: options.system ?? ["baseline", "shadow"],
      ...(options.benchmarkModel ? { benchmarkModel: options.benchmarkModel } : {}),
      ...(options.workRoot ? { workRoot: resolve(workspaceRoot, options.workRoot) } : {})
    },
    { config, providers }
  );

  if (options.out) {
    await writeFile(
      resolve(workspaceRoot, options.out),
      `${JSON.stringify(execution.input, null, 2)}\n`,
      "utf8"
    );
  }
  console.log(options.json ? JSON.stringify(execution.input, null, 2) : formatBenchmarkExecution(execution));

  if (options.report) {
    // A single-system run has no ratios to gate on, so it reports totals instead of
    // failing for want of a baseline it was never asked to run.
    if (pairedSystems(execution.input)) {
      const report = buildBenchmarkReport(execution.input);
      console.log(formatBenchmarkReport(report));
      if (!report.passed) {
        process.exitCode = 1;
      }
    } else {
      console.log(formatBenchmarkSummary(buildBenchmarkSummary(execution.input)));
    }
  }
}

/** True when observations cover both systems, which is what a comparison requires. */
function pairedSystems(input: { observations: Array<{ system: string }> }): boolean {
  const systems = new Set(input.observations.map((observation) => observation.system));
  return systems.has("baseline") && systems.has("shadow");
}

async function reportBenchmark(inputPath: string, options: { json?: boolean }): Promise<void> {
  const path = resolve(process.cwd(), inputPath);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!pairedSystems(parsed)) {
    const summary = buildBenchmarkSummary(parsed);
    console.log(options.json ? JSON.stringify(summary, null, 2) : formatBenchmarkSummary(summary));
    return;
  }
  const report = buildBenchmarkReport(parsed);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatBenchmarkReport(report));
  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function observeBenchmark(
  runId: string,
  options: {
    fixture: string;
    task: string;
    criteriaPassed: number;
    criteriaTotal: number;
    relevantFile?: string[];
    dangerousOperation?: string[];
  }
): Promise<void> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  const store = await openSQLitePersistenceStore(
    resolve(workspaceRoot, config.persistence.databasePath),
    resolve(workspaceRoot, config.persistence.runsDir)
  );
  try {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    const observation = await buildShadowObservation(run, {
      fixtureId: options.fixture,
      taskId: options.task,
      acceptanceCriteriaPassed: options.criteriaPassed,
      acceptanceCriteriaTotal: options.criteriaTotal,
      relevantFiles: options.relevantFile ?? [],
      dangerousOperations: options.dangerousOperation ?? []
    }, new ArtifactStore(resolve(workspaceRoot, config.persistence.artifactsDir)));
    console.log(JSON.stringify(observation, null, 2));
  } finally {
    store.close();
  }
}

async function doctor(options: { probe?: boolean } = {}): Promise<void> {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const pnpmAvailable = await commandWorks("pnpm", ["--version"]);
  const { config } = await loadConfig(process.cwd());
  await validateConfig();
  const nodeSupported = (nodeMajor ?? 0) > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 11);
  console.log(`Node.js: ${process.versions.node} ${nodeSupported ? "ok" : "requires 22.11+"}`);
  console.log(`pnpm: ${pnpmAvailable ? "ok" : "not found; enable with Corepack or install pnpm"}`);
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.kind === "mock") {
      console.log(`Provider ${id}: mock (must be injected by the caller)`);
      continue;
    }
    const environmentName = provider.apiKeyEnv;
    console.log(
      `Provider ${id}: ${environmentName && process.env[environmentName] ? "credentials set" : `missing ${environmentName ?? "credential environment variable"}`}`
    );
  }
  if (options.probe && !(await probeModels(config))) {
    process.exitCode = 1;
  }
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolveCommand) => {
    execFile(command, args, (error) => resolveCommand(!error));
  });
}

async function commandOutput(command: string, args: string[], cwd = process.cwd()): Promise<string | undefined> {
  return new Promise((resolveCommand) => {
    execFile(command, args, { cwd }, (error, stdout) => {
      resolveCommand(error ? undefined : stdout.trim());
    });
  });
}

async function latestRun(runId?: string): Promise<Run | undefined> {
  const store = await buildStore(process.cwd());
  try {
    return runId ? await store.getRun(runId) : (await store.listRuns())[0];
  } finally {
    store.close();
  }
}

async function showRunPlan(runId?: string): Promise<void> {
  const run = await latestRun(runId);
  console.log(run ? formatRunPlan(run) : "No runs found.");
}

async function showRunBudget(runId?: string): Promise<void> {
  const { config } = await loadConfig(process.cwd());
  const run = await latestRun(runId);
  console.log(run ? formatRunBudget(run, config) : `Run tokens: 0/${config.budgets.run.maxTotalTokens}`);
}

async function showRunDiff(runId?: string): Promise<void> {
  const run = await latestRun(runId);
  const recorded = run ? formatRunChangedFiles(run) : "No recorded file changes.";
  const stat = await commandOutput("git", ["diff", "--stat"]);
  console.log(stat ? `${recorded}\n\nWorkspace diff:\n${stat}` : recorded);
}

async function answerChat(message: string, steeringNotes: string[]): Promise<void> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  const { providers, diagnostics } = createConfiguredProviders(config);
  const agent = new ChatOrchestratorAgent(
    new ModelRouter(config, providers),
    config.agents.chat,
    config.budgets.stage
  );
  const context = await summarizeRepositoryForChat(message);
  const result = await agent.run({
    message,
    workspaceRoot,
    repositorySummary: context.summary,
    ...(context.highestPriorityNextStep ? { highestPriorityNextStep: context.highestPriorityNextStep } : {}),
    changedFileCount: context.changedFileCount,
    steeringNotes
  });
  for (const diagnostic of diagnostics) {
    console.log(diagnostic);
  }
  console.log(result.reply);
  if (result.decision === "start_coding") {
    console.log("I have not started coding yet. Say 'start coding' or give me the exact change when you want the lifecycle to run.");
  }
}

async function summarizeRepositoryForChat(_message: string): Promise<{
  summary: string;
  highestPriorityNextStep?: string;
  changedFileCount: number;
}> {
  const workspaceRoot = process.cwd();
  const readme = await readTextIfExists(resolve(workspaceRoot, "README.md"));
  const agents = await readTextIfExists(resolve(workspaceRoot, "AGENTS.md"));
  const status = await commandOutput("git", ["status", "--short"]);
  const repoDescription = firstMeaningfulParagraph(readme)
    ?? "This looks like a local repository; I could not find a README summary.";
  const nextStep = extractHighestPriorityNextStep(agents);
  const changedFileCount = status ? status.split("\n").length : 0;
  const lines = [
    repoDescription,
    `Current working tree changes: ${changedFileCount}.`
  ];
  if (agents) {
    lines.push("AGENTS.md is present with repository-specific working instructions.");
  }
  if (nextStep) {
    lines.push(`Highest-priority next step from AGENTS.md: ${nextStep}`);
  }
  return {
    summary: lines.join("\n"),
    ...(nextStep ? { highestPriorityNextStep: nextStep } : {}),
    changedFileCount
  };
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  return readFile(path, "utf8");
}

function firstMeaningfulParagraph(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  return text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/^# .*\n/u, "").trim())
    .find((paragraph) => paragraph.length > 0);
}

function extractHighestPriorityNextStep(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const section = text.split("### Highest-Priority Next Step")[1];
  if (!section) {
    return undefined;
  }
  return section
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"))
    ?.replace(/\s+/gu, " ");
}

function pendingApprovals(run: Run | undefined): string {
  const approvals = run?.approvals.filter((approval) => approval.status === "pending") ?? [];
  if (approvals.length === 0) {
    return "No pending approvals.";
  }
  return approvals
    .map((approval) =>
      `${approval.id}: ${approval.operation} during ${approval.stage}` +
      (approval.reasons.length > 0 ? `\n  ${approval.reasons.join("; ")}` : "")
    )
    .join("\n");
}

async function formatPreflight(): Promise<string> {
  const workspaceRoot = process.cwd();
  const { config, sources } = await loadConfig(workspaceRoot);
  const gitRoot = await commandOutput("git", ["rev-parse", "--show-toplevel"]);
  const branch = await commandOutput("git", ["branch", "--show-current"]);
  const status = await commandOutput("git", ["status", "--short"]);
  const providerEnv = [
    ...new Set(
      Object.values(config.providers)
        .map((provider) => provider.apiKeyEnv)
        .filter((value): value is string => Boolean(value))
    )
  ];
  const missingKeys = providerEnv.filter((name) => !process.env[name]);
  const tests = config.mcp.tests.enabled
    ? createConfiguredTestsExecutor(config, workspaceRoot)
    : undefined;
  let testsStatus = config.mcp.tests.enabled ? "tests enabled" : "tests disabled";
  if (tests) {
    try {
      const health = await tests.inspect();
      testsStatus = `tests ${health.serverName}@${health.serverVersion}`;
    } catch (error) {
      testsStatus = `tests unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
  } else if (config.mcp.tests.enabled) {
    testsStatus = "tests unavailable";
  }
  const keyStatus = providerEnv.length === 0
    ? "no provider keys configured"
    : missingKeys.length === 0
      ? "provider keys set"
      : `missing ${missingKeys.join(", ")}`;
  const modelSummary = [
    `chat ${config.agents.chat}`,
    `plan ${config.agents.plan}`,
    `develop ${config.agents.develop}`,
    `document ${config.agents.document}`
  ].join(", ");
  const configSummary = sources.length > 0
    ? sources.map((source) => relative(workspaceRoot, source) || source).join(", ")
    : "defaults";

  return [
    `Shadow ${workspaceRoot}`,
    `${gitRoot ? branch || "git attached" : "no git"}; ${status ? `${status.split("\n").length} changed` : "clean"}; ${keyStatus}; ${testsStatus}`,
    `${modelSummary}; budget ${config.budgets.run.maxTotalTokens} tokens, $${config.budgets.run.maxEstimatedCostUsd.toFixed(2)}; /models for all`,
    `config ${configSummary}`,
    "Type a full request, or help."
  ].join("\n");
}

function printHelp(): void {
  console.log([
    "Commands:",
    "  help                 Show this command list. Slash is optional.",
    "  /status [run-id]     Show the current or latest run",
    "  /plan [run-id]       Show selected stages and acceptance criteria",
    "  /budget [run-id]     Show token and cost budget use",
    "  /diff [run-id]       Show recorded changed files and git diff stat",
    "  /approvals           List pending approvals",
    "  /approve [id]        Approve the current run's first or named approval",
    "  /reject [id]         Reject the current run's first or named approval",
    "  /cancel              Cancel the current run if it is still active",
    "  /models              Show configured stage aliases",
    "  /actions             Show deterministic actions",
    "  /preflight           Re-run readiness checks",
    "  /exit                Leave Shadow"
  ].join("\n"));
}

async function interactive(): Promise<void> {
  console.log(await formatPreflight());
  const rl = createInterface({ input, output });
  let currentRunId: string | undefined;
  const steeringNotes: string[] = [];
  const lines = rl[Symbol.asyncIterator]();
  try {
    while (true) {
      output.write("shadow> ");
      const next = await lines.next();
      if (next.done) {
        break;
      }
      const line = next.value.trim();
      if (line.length === 0) {
        continue;
      }
      const parsed = parseInteractiveInput(line);
      if (parsed.kind === "empty") {
        continue;
      }
      if (parsed.kind === "exit") {
        break;
      }
      if (parsed.kind === "unknown") {
        console.log(`Unknown command: ${parsed.command}. Try /help.`);
        continue;
      }
      if (parsed.kind === "incomplete") {
        console.log(parsed.message);
        continue;
      }
      if (parsed.kind === "chat") {
        await answerChat(parsed.message, steeringNotes);
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "help") {
        printHelp();
        continue;
      }
      if (parsed.kind === "command" && (parsed.command === "btw" || parsed.command === "steer")) {
        const note = parsed.args.join(" ").trim();
        if (note.length === 0) {
          console.log("Add the steering note after the command, for example: /steer keep this as a read-only discussion.");
        } else {
          steeringNotes.push(note);
          console.log(`Noted. Steering notes: ${steeringNotes.length}.`);
        }
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "preflight") {
        console.log(await formatPreflight());
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "status") {
        await showStatus(parsed.args[0] ?? currentRunId);
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "models") {
        await showModels();
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "actions") {
        await showActions({});
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "plan") {
        await showRunPlan(parsed.args[0] ?? currentRunId);
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "budget") {
        await showRunBudget(parsed.args[0] ?? currentRunId);
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "diff") {
        await showRunDiff(parsed.args[0] ?? currentRunId);
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "approvals") {
        console.log(pendingApprovals(await latestRun(currentRunId)));
        continue;
      }
      if (parsed.kind === "command" && (parsed.command === "approve" || parsed.command === "reject")) {
        if (!currentRunId) {
          console.log("No current run.");
          continue;
        }
        const approved = await resolveRunApproval(
          parsed.command === "approve" ? "approved" : "rejected",
          currentRunId,
          parsed.args[0]
        );
        if (approved && parsed.command === "approve") {
          const resumed = await resumeRun(currentRunId, {});
          currentRunId = resumed.id;
        }
        continue;
      }
      if (parsed.kind === "command" && parsed.command === "cancel") {
        if (currentRunId) {
          await cancelRun(currentRunId);
        } else {
          console.log("No current run.");
        }
        continue;
      }
      if (parsed.kind !== "request") {
        continue;
      }
      console.log("Starting run. Progress will stay compact; full records are in .shadow.");
      const request = steeringNotes.length > 0
        ? `${parsed.request}\n\nSteering notes:\n${steeringNotes.map((note) => `- ${note}`).join("\n")}`
        : parsed.request;
      const run = await runRequest(request, {
        dryRun: false,
        onRunCreated: (created) => {
          currentRunId = created.id;
          console.log(`run ${created.id}`);
        },
        onEvent: (event) => {
          const formatted = formatProgressEvent(event);
          if (formatted) {
            console.log(`  ${formatted}`);
          }
        }
      });
      currentRunId = run.id;
    }
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name("shadow")
  .description("Local coding-agent harness with lifecycle orchestration and token-aware routing.")
  .version("0.1.0");

program
  .command("run")
  .argument("<request>", "request to run")
  .option("--dry-run", "plan without executing workspace-changing actions")
  .option("--json", "print the run as JSON")
  .action(async (request: string, options: { dryRun?: boolean; json?: boolean }) => {
    exitCodeForRun(await runRequest(request, options));
  });

program.command("init").description("Create repository Shadow configuration").action(initConfig);

program
  .command("status")
  .argument("[run-id]", "run identifier")
  .description("Show run status")
  .action(showStatus);

program
  .command("resume")
  .argument("<run-id>", "run identifier")
  .option("--json", "print the run as JSON")
  .description("Resume an interrupted or approved run")
  .action(async (runId: string, options: { json?: boolean }) => {
    exitCodeForRun(await resumeRun(runId, options));
  });

program
  .command("cancel")
  .argument("<run-id>", "run identifier")
  .description("Cancel a run")
  .action(cancelRun);

program
  .command("approve")
  .argument("<run-id>", "run identifier")
  .argument("[approval-id]", "approval identifier; defaults to the first pending approval")
  .description("Approve a pending operation")
  .action(async (runId: string, approvalId?: string) => {
    await resolveRunApproval("approved", runId, approvalId);
  });

program
  .command("reject")
  .argument("<run-id>", "run identifier")
  .argument("[approval-id]", "approval identifier; defaults to the first pending approval")
  .description("Reject a pending operation and cancel the run")
  .action(async (runId: string, approvalId?: string) => {
    await resolveRunApproval("rejected", runId, approvalId);
  });

program.command("models").description("Show configured model aliases and agent mappings").action(showModels);

program
  .command("actions")
  .description("Deterministic action commands")
  .command("list")
  .option("--json", "print action manifests as JSON")
  .action(showActions);

program
  .command("mcp")
  .description("MCP server commands")
  .command("list")
  .description("Show MCP server health and capabilities")
  .action(showMcpServers);

program
  .command("config")
  .description("Configuration commands")
  .command("validate")
  .action(validateConfig);

const benchmark = program.command("benchmark").description("Benchmark evaluation commands");

benchmark
  .command("run")
  .argument("<fixture-dirs...>", "benchmark fixture directories containing fixture.yaml")
  .requiredOption("--benchmark-id <id>", "identifier recorded on the assembled observations")
  .option("--task <ids...>", "restrict execution to these task identifiers")
  .option("--system <names...>", "systems to run: baseline, shadow")
  .option("--benchmark-model <alias-or-model-id>", "configured alias or provider model id for the single-model baseline")
  .option("--work-root <dir>", "directory for provisioned fixture workspaces")
  .option("--out <path>", "write assembled observations to this JSON file")
  .option("--report", "build and print the paired comparison report")
  .option("--json", "print assembled observations as JSON")
  .description("Provision fixture workspaces, run both systems, and assemble paired observations")
  .action(runBenchmark);

benchmark
  .command("report")
  .argument("<input>", "paired baseline and Shadow observations as JSON")
  .option("--json", "print the report as JSON")
  .action(reportBenchmark);

benchmark
  .command("observe")
  .argument("<run-id>", "completed, failed, or cancelled Shadow run")
  .requiredOption("--fixture <id>", "benchmark fixture identifier")
  .requiredOption("--task <id>", "benchmark task identifier")
  .requiredOption("--criteria-passed <count>", "passed acceptance criteria", Number)
  .requiredOption("--criteria-total <count>", "total acceptance criteria", Number)
  .option("--relevant-file <paths...>", "expected relevant repository paths")
  .option("--dangerous-operation <ids...>", "operations expected to be rejected")
  .action(observeBenchmark);

program
  .command("doctor")
  .description("Check local dependencies and credentials")
  .option("--probe", "send one minimal request per configured tier model to confirm it is reachable")
  .action(doctor);

program
  .command("logs")
  .argument("<run-id>", "run identifier")
  .description("Print raw run events")
  .action(async (runId: string) => {
    const store = await buildStore(process.cwd());
    try {
      const events = await store.listEvents(runId);
      if (events.length === 0) {
        console.log(`No events found for ${runId}`);
        return;
      }
      console.log(events.map((event) => JSON.stringify(event)).join("\n"));
    } finally {
      store.close();
    }
  });

try {
  if (process.argv.length <= 2) {
    await interactive();
  } else {
    await program.parseAsync(process.argv);
  }
} catch (error) {
  // A misconfiguration is not a crash: report the cause, not a stack trace.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
