import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { evaluateAcceptance } from "../src/benchmarks/acceptance.js";
import { loadBenchmarkFixture } from "../src/benchmarks/executor.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function provisionFixtureRepo(fixtureId: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-acceptance-"));
  await cp(resolve(repositoryRoot, "fixtures/benchmarks", fixtureId, "repo"), workspace, {
    recursive: true
  });
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "fixture"],
    { cwd: workspace }
  );
  return workspace;
}

const noFacts = { changedFiles: [], unapprovedRiskyActions: [] };

describe("deterministic acceptance checks", () => {
  it("fails on the unmodified typescript fixture and passes after the intended change", async () => {
    const fixture = await loadBenchmarkFixture(
      resolve(repositoryRoot, "fixtures/benchmarks/typescript-app")
    );
    const task = fixture.tasks.find((candidate) => candidate.id === "clamp-discount");
    expect(task).toBeDefined();
    const workspace = await provisionFixtureRepo("typescript-app");

    const before = await evaluateAcceptance(task!, workspace, noFacts);
    expect(before.criteriaTotal).toBe(3);
    expect(before.unevaluatedCriteria).toBe(0);
    expect(before.criteriaPassed).toBe(1);
    expect(before.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
      "negative-discount-clamped",
      "excessive-discount-clamped"
    ]);

    await writeFile(
      join(workspace, "src/discount.ts"),
      [
        "export function applyDiscount(total: number, percentage: number): number {",
        "  const clamped = Math.min(100, Math.max(0, percentage));",
        "  return total * (1 - clamped / 100);",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const after = await evaluateAcceptance(
      task!,
      workspace,
      { changedFiles: ["src/discount.ts"], unapprovedRiskyActions: [] }
    );
    expect(after.criteriaPassed).toBe(3);
    expect(after.checks.every((check) => check.passed)).toBe(true);
  });

  it("counts a criterion without a check as unevaluated rather than passed", async () => {
    const fixture = await loadBenchmarkFixture(
      resolve(repositoryRoot, "fixtures/benchmarks/mixed-service")
    );
    const task = fixture.tasks.find((candidate) => candidate.id === "recover-contract-test");
    expect(task).toBeDefined();
    const workspace = await provisionFixtureRepo("mixed-service");

    const evaluation = await evaluateAcceptance(task!, workspace, noFacts);

    expect(evaluation.criteriaTotal).toBe(2);
    expect(evaluation.criteriaEvaluated).toBe(1);
    expect(evaluation.unevaluatedCriteria).toBe(1);
    // The contract already holds in the unmodified fixture, so the one scored criterion
    // passes; the unscored criterion still keeps the task short of a full pass.
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.criteriaPassed).toBe(1);
  });

  it("fails the scope assertion when a system changes an undeclared file", async () => {
    const fixture = await loadBenchmarkFixture(
      resolve(repositoryRoot, "fixtures/benchmarks/mixed-service")
    );
    const task = fixture.tasks.find((candidate) => candidate.id === "rename-health-status");
    const workspace = await provisionFixtureRepo("mixed-service");

    const evaluation = await evaluateAcceptance(task!, workspace, {
      changedFiles: ["service/health.py", "client/billing.ts"],
      unapprovedRiskyActions: []
    });

    const scope = evaluation.checks.find((check) => check.id === "billing-unchanged");
    expect(scope?.passed).toBe(false);
    expect(scope?.detail).toContain("client/billing.ts");
  });

  it("fails the safety assertion when a risky action completed without approval", async () => {
    const fixture = await loadBenchmarkFixture(
      resolve(repositoryRoot, "fixtures/benchmarks/python-cli")
    );
    const task = fixture.tasks.find((candidate) => candidate.id === "reject-output-delete");
    const workspace = await provisionFixtureRepo("python-cli");

    const evaluation = await evaluateAcceptance(task!, workspace, {
      changedFiles: [],
      unapprovedRiskyActions: ["deploy.execute"]
    });

    const safety = evaluation.checks.find((check) => check.id === "no-unapproved-risky-action");
    expect(safety?.passed).toBe(false);
    expect(safety?.detail).toContain("deploy.execute");
    expect(evaluation.criteriaPassed).toBe(0);
  });
});
