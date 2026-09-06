import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/store.js";
import { executeProcess } from "../../tools/process.js";
import { parsePytestJunit, parseVitestReport } from "./parsers.js";
import {
  DiscoverTestsRequestSchema,
  TestRunRequestSchema,
  TestRunSummarySchema,
  type DiscoverTestsResult,
  type TestFramework,
  type TestRunAccepted,
  type TestRunRequest,
  type TestRunSummary
} from "./types.js";

interface ActiveTestRun {
  controller: AbortController;
  request: TestRunRequest;
  summary: TestRunSummary;
}

interface CommandPlan {
  framework: "vitest" | "pytest";
  command: string[];
  reportPath: string;
  coveragePath?: string;
  cleanupDir: string;
}

export class TestsService {
  private readonly runs = new Map<string, ActiveTestRun>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly artifacts: ArtifactStore
  ) {}

  async discoverTests(input: unknown): Promise<DiscoverTestsResult> {
    const request = DiscoverTestsRequestSchema.parse(input);
    this.assertWorkspace(request.workspace_id);
    const framework = this.resolveFramework(request.framework);
    if (!framework) {
      return { tests: [], status: "not_configured", message: "No Vitest or pytest installation was detected." };
    }
    const controller = new AbortController();
    const command = framework === "vitest"
      ? [this.vitestBinary()!, "list", "--json"]
      : ["python3", "-m", "pytest", "--collect-only", "-q"];
    const result = await executeProcess(command, {
      workspaceRoot: this.workspaceRoot,
      cwd: this.workspaceRoot,
      timeoutMs: 60_000,
      maxOutputBytes: 2_000_000,
      signal: controller.signal
    });
    const missingRunner = this.missingRunnerMessage(framework, result.stderr || result.stdout);
    if (missingRunner) {
      return { framework, tests: [], status: "not_configured", message: missingRunner };
    }
    if (result.exitCode !== 0) {
      return { framework, tests: [], status: "failed", message: this.compactMessage(result.stderr || result.stdout) };
    }
    const tests = framework === "vitest"
      ? zodVitestDiscovery(result.stdout)
      : result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.includes("::"));
    return { framework, tests, status: "completed" };
  }

  runTests(input: unknown): TestRunAccepted {
    const request = TestRunRequestSchema.parse(input);
    this.assertWorkspace(request.workspace_id);
    const runId = randomUUID();
    const active: ActiveTestRun = {
      controller: new AbortController(),
      request,
      summary: TestRunSummarySchema.parse({
        run_id: runId,
        status: "queued",
        counts: {},
        duration_ms: 0,
        attempts: 0
      })
    };
    this.runs.set(runId, active);
    void this.execute(active).catch((error: unknown) => {
      active.summary = TestRunSummarySchema.parse({
        ...active.summary,
        status: active.controller.signal.aborted ? "cancelled" : "failed",
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return { run_id: runId, status: "queued" };
  }

  getStatus(runId: string): TestRunAccepted {
    const active = this.requireRun(runId);
    return { run_id: runId, status: active.summary.status };
  }

  getSummary(runId: string): TestRunSummary {
    return this.requireRun(runId).summary;
  }

  getFailureDetails(runId: string, testId?: string): TestRunSummary["failures"] {
    const failures = this.requireRun(runId).summary.failures;
    return testId ? failures.filter((failure) => failure.test_id === testId) : failures;
  }

  getCoverageSummary(runId: string): TestRunSummary["coverage"] {
    return this.requireRun(runId).summary.coverage;
  }

  cancelTestRun(runId: string): TestRunAccepted {
    const active = this.requireRun(runId);
    if (active.summary.status === "queued" || active.summary.status === "running") {
      active.controller.abort();
      active.summary = { ...active.summary, status: "cancelled" };
    }
    return { run_id: runId, status: active.summary.status };
  }

  private async execute(active: ActiveTestRun): Promise<void> {
    const startedAt = performance.now();
    const framework = this.resolveFramework(active.request.framework);
    if (!framework) {
      active.summary = {
        ...active.summary,
        status: "not_configured",
        message: "No Vitest or pytest installation was detected."
      };
      return;
    }
    active.summary = { ...active.summary, framework, status: "running" };

    for (let attempt = 1; attempt <= active.request.max_retries + 1; attempt += 1) {
      if (active.controller.signal.aborted) {
        active.summary = { ...active.summary, status: "cancelled", attempts: attempt - 1 };
        return;
      }
      const plan = await this.commandPlan(active.summary.run_id, framework, active.request);
      try {
        const result = await executeProcess(plan.command, {
          workspaceRoot: this.workspaceRoot,
          cwd: this.workspaceRoot,
          timeoutMs: active.request.timeout_seconds * 1_000,
          maxOutputBytes: 10_000_000,
          signal: active.controller.signal
        });
        const log = [result.stdout, result.stderr].filter(Boolean).join("\n");
        const logArtifact = await this.artifacts.writeText(
          "tests.log",
          `${active.summary.run_id}.log`,
          log
        );
        const missingRunner = this.missingRunnerMessage(plan.framework, log);
        if (missingRunner && !existsSync(plan.reportPath)) {
          active.summary = TestRunSummarySchema.parse({
            ...active.summary,
            status: "not_configured",
            counts: { passed: 0, failed: 0, skipped: 0 },
            failures: [],
            duration_ms: Math.round(performance.now() - startedAt),
            attempts: attempt,
            artifacts: [...active.summary.artifacts, logArtifact],
            coverage: { status: "unavailable" },
            message: missingRunner
          });
          return;
        }
        const parsed = await this.parseReport(plan, result.exitCode === 0);
        const coverage = await this.parseCoverage(plan);
        const failures = parsed.failures.map((failure) => ({
          ...failure,
          log_artifact_id: logArtifact.id
        }));
        const status = active.controller.signal.aborted
          ? "cancelled"
          : result.timedOut
            ? "timed_out"
            : result.exitCode === 0 && parsed.counts.failed === 0
              ? "passed"
              : "failed";
        active.summary = TestRunSummarySchema.parse({
          ...active.summary,
          status,
          counts: parsed.counts,
          failures,
          duration_ms: Math.round(performance.now() - startedAt),
          attempts: attempt,
          artifacts: [...active.summary.artifacts, logArtifact],
          coverage,
          message: result.outputLimitExceeded ? "Test output exceeded the 10 MB capture limit." : undefined
        });
        if (status !== "failed") {
          return;
        }
      } finally {
        await rm(plan.cleanupDir, { recursive: true, force: true });
      }
    }
  }

  private async commandPlan(
    runId: string,
    framework: "vitest" | "pytest",
    request: TestRunRequest
  ): Promise<CommandPlan> {
    const cleanupDir = resolve(this.workspaceRoot, ".shadow/test-runs", `${runId}-${randomUUID()}`);
    await mkdir(cleanupDir, { recursive: true });
    if (framework === "vitest") {
      const reportPath = resolve(cleanupDir, "vitest.json");
      return {
        framework,
        reportPath,
        ...(request.coverage
          ? { coveragePath: resolve(cleanupDir, "coverage/coverage-summary.json") }
          : {}),
        cleanupDir,
        command: [
          this.vitestBinary()!,
          "run",
          "--reporter=json",
          `--outputFile=${reportPath}`,
          ...(request.coverage
            ? [
                "--coverage",
                "--coverage.reporter=json-summary",
                `--coverage.reportsDirectory=${resolve(cleanupDir, "coverage")}`
              ]
            : []),
          ...request.selectors
        ]
      };
    }
    const reportPath = resolve(cleanupDir, "pytest.xml");
    return {
      framework,
      reportPath,
      cleanupDir,
      command: ["python3", "-m", "pytest", `--junitxml=${reportPath}`, ...request.selectors]
    };
  }

  private async parseReport(
    plan: CommandPlan,
    passed: boolean
  ): Promise<ReturnType<typeof parseVitestReport>> {
    if (!existsSync(plan.reportPath)) {
      return {
        counts: { passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0 },
        failures: passed
          ? []
          : [{ test_id: "test process", category: "unknown", message: "The test runner did not produce a report.", relevant_frames: [] }]
      };
    }
    const source = await readFile(plan.reportPath, "utf8");
    return plan.framework === "vitest" ? parseVitestReport(source) : parsePytestJunit(source);
  }

  private async parseCoverage(plan: CommandPlan): Promise<TestRunSummary["coverage"]> {
    if (!plan.coveragePath || !existsSync(plan.coveragePath)) {
      return { status: "unavailable" };
    }
    const report = CoverageFileSchema.parse(JSON.parse(await readFile(plan.coveragePath, "utf8")));
    return {
      status: "available",
      lines_percent: report.total.lines.pct,
      branches_percent: report.total.branches.pct,
      functions_percent: report.total.functions.pct,
      statements_percent: report.total.statements.pct
    };
  }

  private resolveFramework(framework: TestFramework): "vitest" | "pytest" | undefined {
    if (framework === "vitest") {
      return this.vitestBinary() ? "vitest" : undefined;
    }
    if (framework === "pytest") {
      return this.pytestConfigured() ? "pytest" : undefined;
    }
    return this.vitestBinary() ? "vitest" : this.pytestConfigured() ? "pytest" : undefined;
  }

  private vitestBinary(): string | undefined {
    const path = resolve(this.workspaceRoot, "node_modules/.bin/vitest");
    return existsSync(path) ? path : undefined;
  }

  private pytestConfigured(): boolean {
    return ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((name) =>
      existsSync(resolve(this.workspaceRoot, name))
    );
  }

  private assertWorkspace(workspaceId: string): void {
    if (resolve(workspaceId) !== resolve(this.workspaceRoot)) {
      throw new Error("Tests MCP request does not match the server workspace.");
    }
  }

  private requireRun(runId: string): ActiveTestRun {
    const active = this.runs.get(runId);
    if (!active) {
      throw new Error(`Test run ${runId} was not found.`);
    }
    return active;
  }

  private compactMessage(message: string): string {
    return message.trim().split("\n").slice(0, 8).join("\n").slice(0, 2_000);
  }

  private missingRunnerMessage(framework: "vitest" | "pytest", log: string): string | undefined {
    if (framework === "pytest" && /No module named pytest/.test(log)) {
      return "pytest is not installed in the selected Python environment.";
    }
    return undefined;
  }
}

const VitestDiscoverySchema = z.array(z.object({ name: z.string(), file: z.string() }));
const CoverageMetricSchema = z.object({ pct: z.number().min(0).max(100) });
const CoverageFileSchema = z.object({
  total: z.object({
    lines: CoverageMetricSchema,
    branches: CoverageMetricSchema,
    functions: CoverageMetricSchema,
    statements: CoverageMetricSchema
  })
});

function zodVitestDiscovery(source: string): string[] {
  return VitestDiscoverySchema.parse(JSON.parse(source)).map((test) => `${test.file} > ${test.name}`);
}
