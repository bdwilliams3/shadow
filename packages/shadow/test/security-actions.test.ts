import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";
import type { DependencyScanResult, SecretScanResult } from "../src/tools/actions/security.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";

async function fixtureRunner(): Promise<{
  workspace: string;
  artifacts: ArtifactStore;
  runner: ActionRunner;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-security-"));
  const artifacts = new ArtifactStore(join(workspace, ".shadow/artifacts"));
  return {
    workspace,
    artifacts,
    runner: new ActionRunner(createDefaultActionRegistry(), workspace, defaultConfig, artifacts)
  };
}

describe("security actions", () => {
  it("reports secret locations without persisting the matched value", async () => {
    const { workspace, artifacts, runner } = await fixtureRunner();
    const secret = `ghp_${"a".repeat(36)}`;
    await writeFile(join(workspace, "credentials.ts"), `export const token = "${secret}";\n`, "utf8");

    const result = await runner.run<SecretScanResult>("security.secrets", {});
    const resultArtifact = result.artifacts.find((artifact) => artifact.kind === "action.result");

    expect(result.record.status).toBe("failed");
    expect(result.output?.highConfidenceFindings).toBe(1);
    expect(result.output?.findings[0]).toMatchObject({
      path: "credentials.ts",
      line: 1,
      rule: "github_token",
      severity: "high"
    });
    expect(await artifacts.readText(resultArtifact!)).not.toContain(secret);
  });

  it("returns structured dependency integrity warnings without network access", async () => {
    const { workspace, runner } = await fixtureRunner();
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      dependencies: { unstable: "latest", direct: "https://example.com/direct.tgz" }
    }), "utf8");

    const result = await runner.run<DependencyScanResult>("security.dependencies", {});

    expect(result.record.status).toBe("completed");
    expect(result.output?.status).toBe("warnings");
    expect(result.output?.advisoryDatabase).toBe("not_checked");
    expect(result.output?.findings.map((finding) => finding.rule)).toEqual([
      "unbounded_version",
      "remote_source",
      "missing_lockfile"
    ]);
  });

  it("fails validation when a high-confidence secret is present", async () => {
    const { workspace } = await fixtureRunner();
    await writeFile(
      join(workspace, "config.ts"),
      `export const key = "sk-${"b".repeat(32)}";\n`,
      "utf8"
    );
    const config = structuredClone(defaultConfig);
    config.lifecycle.enabledStages = ["validate"];
    config.lifecycle.maxStageRetries = 0;
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));

    const run = await new LifecycleOrchestrator(config, store).run({
      request: "validate the current implementation",
      workspaceRoot: workspace,
      dryRun: false
    });

    expect(run.state).toBe("FAILED");
    expect(run.stageRuns[0]?.result?.testResults).toContain("secrets:findings");
  });
});
