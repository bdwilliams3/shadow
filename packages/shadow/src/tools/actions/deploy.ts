import { z } from "zod";
import type { ActionDefinition, ProcessResult } from "../types.js";

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const DeploymentActionInputSchema = z.object({
  profile: z.string().min(1),
  environment: z.string().min(1),
  command: z.array(z.string()).min(1),
  credentialEnv: z.array(EnvironmentNameSchema).default([])
});

const DeploymentExecutionInputSchema = DeploymentActionInputSchema.extend({
  healthCheckCommand: z.array(z.string()).min(1)
});

export const DeploymentExecutionResultSchema = z.object({
  profile: z.string().min(1),
  environment: z.string().min(1),
  deploymentStatus: z.enum(["succeeded", "failed"]),
  healthStatus: z.enum(["healthy", "unhealthy", "not_run"]),
  deployCommand: z.array(z.string()).min(1),
  healthCheckCommand: z.array(z.string()).min(1)
});
export type DeploymentExecutionResult = z.infer<typeof DeploymentExecutionResultSchema>;

export const DeploymentRollbackResultSchema = z.object({
  profile: z.string().min(1),
  environment: z.string().min(1),
  status: z.enum(["rolled_back", "failed"]),
  command: z.array(z.string()).min(1)
});
export type DeploymentRollbackResult = z.infer<typeof DeploymentRollbackResultSchema>;

function succeeded(result: ProcessResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded;
}

function redactEnvironmentValues(text: string, names: readonly string[]): string {
  return names.reduce((redacted, name) => {
    const value = process.env[name];
    return value ? redacted.split(value).join(`[REDACTED_${name}]`) : redacted;
  }, text);
}

function combinedOutput(results: readonly ProcessResult[], names: readonly string[]): {
  stdout: string;
  stderr: string;
} {
  return {
    stdout: redactEnvironmentValues(results.map((result) => result.stdout).filter(Boolean).join("\n"), names),
    stderr: redactEnvironmentValues(results.map((result) => result.stderr).filter(Boolean).join("\n"), names)
  };
}

export const deployExecuteAction: ActionDefinition<
  z.infer<typeof DeploymentExecutionInputSchema>,
  DeploymentExecutionResult
> = {
  manifest: {
    id: "deploy.execute",
    version: 1,
    description: "Run a configured deployment command and its health check.",
    handler: "@shadow/actions/deploy/execute",
    inputSchema: "deployment_execution_input_v1",
    outputSchema: "deployment_execution_result_v1",
    risk: "external_write",
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
    network: true,
    writesWorkspace: true,
    writesOutsideWorkspace: false,
    deploys: true,
    touchesSecrets: true,
    idempotent: false
  },
  input: DeploymentExecutionInputSchema,
  output: DeploymentExecutionResultSchema,
  async run(input, context) {
    const deployment = await context.execute(input.command, {
      environmentNames: input.credentialEnv
    });
    if (!succeeded(deployment)) {
      const output = combinedOutput([deployment], input.credentialEnv);
      return {
        summary: `Deployment profile ${input.profile} failed before health verification.`,
        output: {
          profile: input.profile,
          environment: input.environment,
          deploymentStatus: "failed",
          healthStatus: "not_run",
          deployCommand: input.command,
          healthCheckCommand: input.healthCheckCommand
        },
        commands: [input.command],
        exitCode: deployment.exitCode ?? 1,
        ...output
      };
    }

    const health = await context.execute(input.healthCheckCommand, {
      environmentNames: input.credentialEnv
    });
    const healthy = succeeded(health);
    const output = combinedOutput([deployment, health], input.credentialEnv);
    return {
      summary: healthy
        ? `Deployment profile ${input.profile} passed its health check.`
        : `Deployment profile ${input.profile} completed, but its health check failed.`,
      output: {
        profile: input.profile,
        environment: input.environment,
        deploymentStatus: "succeeded",
        healthStatus: healthy ? "healthy" : "unhealthy",
        deployCommand: input.command,
        healthCheckCommand: input.healthCheckCommand
      },
      commands: [input.command, input.healthCheckCommand],
      exitCode: healthy ? 0 : health.exitCode ?? 1,
      ...output
    };
  }
};

export const deployRollbackAction: ActionDefinition<
  z.infer<typeof DeploymentActionInputSchema>,
  DeploymentRollbackResult
> = {
  manifest: {
    id: "deploy.rollback",
    version: 1,
    description: "Run a configured rollback command after deployment health-check failure.",
    handler: "@shadow/actions/deploy/rollback",
    inputSchema: "deployment_rollback_input_v1",
    outputSchema: "deployment_rollback_result_v1",
    risk: "destructive",
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
    network: true,
    writesWorkspace: true,
    writesOutsideWorkspace: false,
    deploys: true,
    touchesSecrets: true,
    idempotent: false
  },
  input: DeploymentActionInputSchema,
  output: DeploymentRollbackResultSchema,
  async run(input, context) {
    const rollback = await context.execute(input.command, {
      environmentNames: input.credentialEnv
    });
    const rolledBack = succeeded(rollback);
    const output = combinedOutput([rollback], input.credentialEnv);
    return {
      summary: rolledBack
        ? `Deployment profile ${input.profile} was rolled back.`
        : `Rollback for deployment profile ${input.profile} failed.`,
      output: {
        profile: input.profile,
        environment: input.environment,
        status: rolledBack ? "rolled_back" : "failed",
        command: input.command
      },
      commands: [input.command],
      exitCode: rolledBack ? 0 : rollback.exitCode ?? 1,
      ...output
    };
  }
};
