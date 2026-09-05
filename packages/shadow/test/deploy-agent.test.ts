import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";

async function fixtureWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-deploy-"));
}

function deploymentConfig(options: { unhealthy?: boolean; rollback?: boolean } = {}) {
  const config = structuredClone(defaultConfig);
  config.lifecycle.enabledStages = ["deploy"];
  config.deployment = {
    defaultProfile: "staging",
    profiles: {
      staging: {
        environment: "staging",
        deployCommand: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync('deploy-count.txt', '1')"
        ],
        healthCheckCommand: [process.execPath, "-e", `process.exit(${options.unhealthy ? 1 : 0})`],
        ...(options.rollback
          ? {
              rollbackCommand: [
                process.execPath,
                "-e",
                "require('node:fs').writeFileSync('rollback.txt', 'done')"
              ]
            }
          : {}),
        credentialEnv: []
      }
    }
  };
  return config;
}

describe("DeployAgent", () => {
  it("previews a configured deployment without external execution in dry-run mode", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const run = await new LifecycleOrchestrator(deploymentConfig(), store).run({
      request: "deploy the current build",
      workspaceRoot: workspace,
      dryRun: true
    });

    const deploy = run.stageRuns.find((stage) => stage.stage === "deploy")?.result;
    expect(run.state).toBe("COMPLETED");
    expect(deploy?.artifacts.some((artifact) => artifact.kind === "deploy.plan")).toBe(true);
    expect(deploy?.toolCalls).toEqual([]);
    await expect(readFile(join(workspace, "deploy-count.txt"), "utf8")).rejects.toThrow();
  });

  it("requires approval, deploys once, and verifies health", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(deploymentConfig(), store);

    const waiting = await orchestrator.run({
      request: "deploy the current build",
      workspaceRoot: workspace,
      dryRun: false
    });
    expect(waiting.state).toBe("AWAITING_APPROVAL");
    expect(waiting.approvals[0]).toMatchObject({ operation: "deploy.execute", status: "pending" });

    await store.resolveApproval(waiting.id, waiting.approvals[0]!.id, "approved");
    const completed = await orchestrator.resume(waiting.id);
    const deploy = completed.stageRuns.find((stage) => stage.stage === "deploy");

    expect(completed.state).toBe("COMPLETED");
    expect(await readFile(join(workspace, "deploy-count.txt"), "utf8")).toBe("1");
    expect(deploy?.attempts).toBe(2);
    expect(deploy?.result?.artifacts.some((artifact) => artifact.kind === "deploy.receipt")).toBe(true);
    expect(deploy?.result?.toolCalls.map((call) => call.actionId)).toEqual(["deploy.execute"]);
  });

  it("requests separate rollback approval and never repeats an unhealthy deploy", async () => {
    const workspace = await fixtureWorkspace();
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(
      deploymentConfig({ unhealthy: true, rollback: true }),
      store
    );

    const deployApproval = await orchestrator.run({
      request: "deploy the current build",
      workspaceRoot: workspace,
      dryRun: false
    });
    await store.resolveApproval(deployApproval.id, deployApproval.approvals[0]!.id, "approved");
    const rollbackApproval = await orchestrator.resume(deployApproval.id);

    expect(rollbackApproval.state).toBe("AWAITING_APPROVAL");
    expect(rollbackApproval.approvals.at(-1)).toMatchObject({
      operation: "deploy.rollback",
      status: "pending"
    });
    expect(await readFile(join(workspace, "deploy-count.txt"), "utf8")).toBe("1");

    await store.resolveApproval(
      rollbackApproval.id,
      rollbackApproval.approvals.at(-1)!.id,
      "approved"
    );
    const rolledBack = await orchestrator.resume(rollbackApproval.id);

    expect(rolledBack.state).toBe("FAILED");
    expect(await readFile(join(workspace, "deploy-count.txt"), "utf8")).toBe("1");
    expect(await readFile(join(workspace, "rollback.txt"), "utf8")).toBe("done");
    expect(rolledBack.stageRuns.find((stage) => stage.stage === "deploy")?.result?.artifacts
      .some((artifact) => artifact.kind === "deploy.rollback.receipt")).toBe(true);
  });

  it("passes only named credential variables and redacts their values from logs", async () => {
    const workspace = await fixtureWorkspace();
    const artifacts = new ArtifactStore(join(workspace, ".shadow/artifacts"));
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      artifacts
    );
    const environmentName = "SHADOW_DEPLOY_TEST_SECRET";
    const secret = "deployment-secret-value";
    process.env[environmentName] = secret;
    try {
      const result = await runner.run("deploy.execute", {
        profile: "staging",
        environment: "staging",
        command: [process.execPath, "-e", `console.log(process.env.${environmentName})`],
        healthCheckCommand: [process.execPath, "-e", "process.exit(0)"],
        credentialEnv: [environmentName]
      }, { approved: true, allowWorkspaceWrites: true });
      const stdout = result.artifacts.find((artifact) => artifact.kind === "action.stdout");

      expect(result.record.status).toBe("completed");
      expect(stdout).toBeDefined();
      expect(await artifacts.readText(stdout!)).toContain(`[REDACTED_${environmentName}]`);
      expect(await artifacts.readText(stdout!)).not.toContain(secret);
    } finally {
      delete process.env[environmentName];
    }
  });
});
