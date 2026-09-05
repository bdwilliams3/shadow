import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";
import type { DeploymentProfile, ShadowConfig } from "../config/schema.js";
import type { ArtifactReference, StageResult, StageTask } from "../orchestration/types.js";
import type {
  DeploymentExecutionResult,
  DeploymentRollbackResult
} from "../tools/actions/deploy.js";
import type { ActionRunner } from "../tools/runner.js";
import type { Agent, StageContext } from "./contract.js";

const DeploymentPlanSchema = z.object({
  version: z.literal(1),
  profile: z.string().min(1),
  environment: z.string().min(1),
  deployCommand: z.array(z.string()).min(1),
  healthCheckCommand: z.array(z.string()).min(1),
  rollbackCommand: z.array(z.string()).min(1).optional(),
  credentialEnv: z.array(z.string()),
  dryRun: z.boolean()
});

const DeploymentReceiptSchema = z.object({
  version: z.literal(1),
  profile: z.string().min(1),
  environment: z.string().min(1),
  deploymentStatus: z.enum(["succeeded", "failed"]),
  healthStatus: z.enum(["healthy", "unhealthy", "not_run"])
});
type DeploymentReceipt = z.infer<typeof DeploymentReceiptSchema>;

const noUsage = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0
};

export class DeployAgent implements Agent {
  constructor(
    private readonly actions: ActionRunner,
    private readonly artifacts: ArtifactStore,
    private readonly deployment: ShadowConfig["deployment"]
  ) {}

  async run(task: StageTask, context: StageContext): Promise<StageResult> {
    const selected = this.selectProfile();
    if (!selected) {
      return this.result({
        status: "blocked",
        summary: "No deployment profile is configured.",
        openRisks: [
          "Configure deployment.defaultProfile and deployment.profiles before executing a deployment."
        ]
      });
    }

    const [profileName, profile] = selected;
    const plan = DeploymentPlanSchema.parse({
      version: 1,
      profile: profileName,
      environment: profile.environment,
      deployCommand: profile.deployCommand,
      healthCheckCommand: profile.healthCheckCommand,
      rollbackCommand: profile.rollbackCommand,
      credentialEnv: profile.credentialEnv,
      dryRun: context.dryRun
    });
    const planArtifact = await this.writeJson("deploy.plan", "deployment-plan.json", plan);

    if (context.dryRun) {
      return this.result({
        status: "completed",
        summary: `Dry run prepared deployment profile ${profileName} for ${profile.environment}.`,
        artifacts: [planArtifact],
        decisions: ["Deployment and health-check commands were previewed without execution."],
        openRisks: ["External deployment effects were skipped in dry-run mode."]
      });
    }

    const missingEnvironment = profile.credentialEnv.filter((name) => process.env[name] === undefined);
    if (missingEnvironment.length > 0) {
      return this.result({
        status: "blocked",
        summary: `Deployment profile ${profileName} is missing required environment variables.`,
        artifacts: [planArtifact],
        openRisks: [`Missing credential environment variables: ${missingEnvironment.join(", ")}.`]
      });
    }

    const previousReceipt = await this.readReceipt(task.inputs);
    if (previousReceipt instanceof Error) {
      return this.result({
        status: "blocked",
        summary: previousReceipt.message,
        artifacts: [planArtifact],
        openRisks: ["Deployment state could not be verified; execution stopped to avoid a duplicate deploy."]
      });
    }
    if (previousReceipt) {
      if (previousReceipt.profile !== profileName || previousReceipt.environment !== profile.environment) {
        return this.result({
          status: "blocked",
          summary: "The configured deployment profile changed after execution began.",
          artifacts: [planArtifact],
          openRisks: ["Manual reconciliation is required before deployment can continue."]
        });
      }
      if (previousReceipt.healthStatus === "healthy") {
        return this.result({
          status: "completed",
          summary: `Deployment profile ${profileName} was already executed and verified healthy.`,
          artifacts: [planArtifact],
          decisions: ["Reused the integrity-checked deployment receipt instead of deploying again."]
        });
      }
      return this.rollback(profileName, profile, planArtifact, task.writePermissions, context);
    }

    const execution = await this.actions.run<DeploymentExecutionResult>(
      "deploy.execute",
      {
        profile: profileName,
        environment: profile.environment,
        command: profile.deployCommand,
        healthCheckCommand: profile.healthCheckCommand,
        credentialEnv: profile.credentialEnv
      },
      {
        allowWorkspaceWrites: task.writePermissions,
        approved: context.approvedOperations.includes("deploy.execute")
      }
    );
    const artifacts = [planArtifact, ...execution.artifacts];

    if (!execution.output) {
      return this.result({
        status: execution.record.status === "blocked" ? "blocked" : "failed",
        summary: execution.record.summary,
        artifacts,
        toolCalls: [execution.record],
        openRisks: [execution.record.summary]
      });
    }

    const receipt = await this.writeReceipt(execution.output);
    artifacts.push(receipt);
    if (execution.output.deploymentStatus === "failed") {
      return this.result({
        status: "blocked",
        summary: execution.record.summary,
        artifacts,
        toolCalls: [execution.record],
        openRisks: ["The deployment command failed; no health check or automatic retry was attempted."]
      });
    }
    if (execution.output.healthStatus === "healthy") {
      return this.result({
        status: "completed",
        summary: execution.record.summary,
        artifacts,
        toolCalls: [execution.record],
        decisions: ["The configured health check passed after deployment."]
      });
    }

    const rollback = await this.rollback(
      profileName,
      profile,
      planArtifact,
      task.writePermissions,
      context
    );
    return {
      ...rollback,
      artifacts: [...artifacts, ...rollback.artifacts.filter((artifact) => artifact.id !== planArtifact.id)],
      toolCalls: [execution.record, ...rollback.toolCalls]
    };
  }

  private async rollback(
    profileName: string,
    profile: DeploymentProfile,
    planArtifact: ArtifactReference,
    allowWorkspaceWrites: boolean,
    context: StageContext
  ): Promise<StageResult> {
    if (!profile.rollbackCommand) {
      return this.result({
        status: "blocked",
        summary: `Deployment profile ${profileName} failed health verification and has no rollback command.`,
        artifacts: [planArtifact],
        openRisks: ["The deployed environment may be unhealthy and requires manual recovery."]
      });
    }

    const rollback = await this.actions.run<DeploymentRollbackResult>(
      "deploy.rollback",
      {
        profile: profileName,
        environment: profile.environment,
        command: profile.rollbackCommand,
        credentialEnv: profile.credentialEnv
      },
      {
        allowWorkspaceWrites,
        approved: context.approvedOperations.includes("deploy.rollback")
      }
    );
    const artifacts = [planArtifact, ...rollback.artifacts];
    if (!rollback.output) {
      return this.result({
        status: "blocked",
        summary: rollback.record.summary,
        artifacts,
        toolCalls: [rollback.record],
        openRisks: [rollback.record.summary]
      });
    }

    const receipt = await this.writeJson("deploy.rollback.receipt", "deployment-rollback.json", {
      version: 1,
      ...rollback.output
    });
    artifacts.push(receipt);
    return this.result({
      status: "blocked",
      summary: rollback.record.summary,
      artifacts,
      toolCalls: [rollback.record],
      decisions: rollback.output.status === "rolled_back"
        ? ["The unhealthy deployment was rolled back; the run remains failed for operator review."]
        : [],
      openRisks: rollback.output.status === "rolled_back"
        ? ["Deployment did not complete; rollback succeeded."]
        : ["Deployment health verification and rollback both failed; manual recovery is required."]
    });
  }

  private selectProfile(): [string, DeploymentProfile] | undefined {
    const entries = Object.entries(this.deployment.profiles);
    if (this.deployment.defaultProfile) {
      const profile = this.deployment.profiles[this.deployment.defaultProfile];
      return profile ? [this.deployment.defaultProfile, profile] : undefined;
    }
    return entries.length === 1 ? entries[0] : undefined;
  }

  private async readReceipt(inputs: readonly ArtifactReference[]): Promise<DeploymentReceipt | Error | undefined> {
    const reference = [...inputs].reverse().find((artifact) => artifact.kind === "deploy.receipt");
    if (!reference) {
      return undefined;
    }
    try {
      return DeploymentReceiptSchema.parse(JSON.parse(await this.artifacts.readText(reference, 20_000)));
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private writeReceipt(output: DeploymentExecutionResult): Promise<ArtifactReference> {
    return this.writeJson("deploy.receipt", "deployment-receipt.json", {
      version: 1,
      profile: output.profile,
      environment: output.environment,
      deploymentStatus: output.deploymentStatus,
      healthStatus: output.healthStatus
    });
  }

  private writeJson(kind: string, name: string, value: unknown): Promise<ArtifactReference> {
    return this.artifacts.writeText(kind, name, `${JSON.stringify(value, null, 2)}\n`);
  }

  private result(
    overrides: Partial<StageResult> & Pick<StageResult, "status" | "summary">
  ): StageResult {
    return {
      status: overrides.status,
      summary: overrides.summary,
      decisions: overrides.decisions ?? [],
      artifacts: overrides.artifacts ?? [],
      changedFiles: [],
      toolCalls: overrides.toolCalls ?? [],
      modelCalls: [],
      testResults: [],
      openRisks: overrides.openRisks ?? [],
      usage: noUsage
    };
  }
}
