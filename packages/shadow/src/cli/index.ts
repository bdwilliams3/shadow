#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, resolve } from "node:path";
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
import { loadConfig, renderDefaultConfig, renderDefaultPolicy } from "../config/load.js";
import { createConfiguredTestsExecutor } from "../mcp/tests/client.js";
import { createConfiguredProviders } from "../models/factory.js";
import { stageCallsModel } from "../orchestration/planner.js";
import type { StageName } from "../orchestration/types.js";
import { LifecycleOrchestrator } from "../orchestration/orchestrator.js";
import type { Run } from "../orchestration/types.js";
import { openSQLitePersistenceStore, type SQLitePersistenceStore } from "../persistence/sqlite-store.js";
import { createDefaultActionRegistry } from "../tools/default-registry.js";
import { formatRunSummary } from "./format.js";

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

async function runRequest(request: string, options: { dryRun?: boolean; json?: boolean }): Promise<Run> {
  const workspaceRoot = process.cwd();
  const { config } = await loadConfig(workspaceRoot);
  const store = await openSQLitePersistenceStore(
    resolve(workspaceRoot, config.persistence.databasePath),
    resolve(workspaceRoot, config.persistence.runsDir)
  );
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
    store.close();
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
  const { config, sources } = await loadConfig(process.cwd());
  console.log(`Config sources: ${sources.length > 0 ? sources.join(", ") : "defaults"}`);
  for (const [stage, tier] of Object.entries(config.agents)) {
    const model = config.models[tier];
    // A tier mapped to a deterministic stage is inert. Saying so avoids the impression
    // that changing it will move any tokens.
    const note = stageCallsModel(stage as StageName) ? "" : "  (deterministic; no model call)";
    console.log(`${stage}: ${tier} -> ${model.provider}/${model.model}${note}`);
  }
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

async function doctor(): Promise<void> {
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
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolveCommand) => {
    execFile(command, args, (error) => resolveCommand(!error));
  });
}

async function interactive(): Promise<void> {
  console.log(
    "Shadow interactive mode. Commands: /status, /plan, /budget, /diff, /approve, /reject, /cancel, /models, /actions, /exit."
  );
  const rl = createInterface({ input, output });
  let currentRunId: string | undefined;
  try {
    while (true) {
      const line = (await rl.question("shadow> ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/exit") {
        break;
      }
      if (line === "/status") {
        await showStatus(currentRunId);
        continue;
      }
      if (line === "/models") {
        await showModels();
        continue;
      }
      if (line === "/actions") {
        await showActions({});
        continue;
      }
      if (line === "/plan") {
        const store = await buildStore(process.cwd());
        try {
          const run = currentRunId ? await store.getRun(currentRunId) : undefined;
          console.log(run ? run.stageTasks.map((task) => task.stage).join(" -> ") : "No current run.");
        } finally {
          store.close();
        }
        continue;
      }
      if (line === "/budget") {
        const { config } = await loadConfig(process.cwd());
        const store = await buildStore(process.cwd());
        try {
          const run = currentRunId ? await store.getRun(currentRunId) : undefined;
          const used = run ? run.usage.inputTokens + run.usage.outputTokens : 0;
          console.log(`Run tokens: ${used}/${config.budgets.run.maxTotalTokens}`);
        } finally {
          store.close();
        }
        continue;
      }
      if (line === "/diff") {
        const store = await buildStore(process.cwd());
        try {
          const run = currentRunId ? await store.getRun(currentRunId) : undefined;
          const files = run
            ? [...new Set(run.stageRuns.flatMap((stage) => stage.result?.changedFiles ?? []))]
            : [];
          console.log(files.length > 0 ? files.join("\n") : "No recorded file changes.");
        } finally {
          store.close();
        }
        continue;
      }
      if (line === "/approve" || line === "/reject") {
        if (!currentRunId) {
          console.log("No current run.");
          continue;
        }
        const approved = await resolveRunApproval(
          line === "/approve" ? "approved" : "rejected",
          currentRunId
        );
        if (approved && line === "/approve") {
          const resumed = await resumeRun(currentRunId, {});
          currentRunId = resumed.id;
        }
        continue;
      }
      if (line === "/cancel") {
        if (currentRunId) {
          await cancelRun(currentRunId);
        } else {
          console.log("No current run.");
        }
        continue;
      }
      const run = await runRequest(line, { dryRun: false });
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

program.command("doctor").description("Check local dependencies and credentials").action(doctor);

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
