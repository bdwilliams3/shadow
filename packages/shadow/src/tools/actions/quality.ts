import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ActionDefinition, ActionHandlerContext, ProcessResult } from "../types.js";

const QualityInputSchema = z.object({
  selectors: z.array(z.string().min(1)).default([])
});

export const QualityResultSchema = z.object({
  check: z.enum(["test", "typecheck"]),
  status: z.enum(["passed", "failed", "not_configured", "unavailable"]),
  command: z.array(z.string()).optional()
});
export type QualityResult = z.infer<typeof QualityResultSchema>;

const PackageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional()
});

async function loadPackageScripts(cwd: string): Promise<Record<string, string>> {
  const packagePath = resolve(cwd, "package.json");
  if (!existsSync(packagePath)) {
    return {};
  }
  const parsed = PackageJsonSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
  return parsed.scripts ?? {};
}

function packageManagerCommand(cwd: string, script: string, selectors: string[]): string[] {
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) {
    return ["pnpm", "run", script, ...(selectors.length > 0 ? ["--", ...selectors] : [])];
  }
  if (existsSync(resolve(cwd, "yarn.lock"))) {
    return ["yarn", script, ...selectors];
  }
  if (existsSync(resolve(cwd, "bun.lock")) || existsSync(resolve(cwd, "bun.lockb"))) {
    return ["bun", "run", script, ...selectors];
  }
  return ["npm", "run", script, ...(selectors.length > 0 ? ["--", ...selectors] : [])];
}

function localBinary(cwd: string, name: string): string | undefined {
  const path = resolve(cwd, "node_modules/.bin", name);
  return existsSync(path) ? path : undefined;
}

function testCommand(cwd: string, scripts: Record<string, string>, selectors: string[]): string[] | undefined {
  const vitest = localBinary(cwd, "vitest");
  if (vitest && scripts.test?.includes("vitest")) {
    return [vitest, "run", ...selectors];
  }
  return scripts.test ? packageManagerCommand(cwd, "test", selectors) : undefined;
}

function typecheckCommand(cwd: string, scripts: Record<string, string>): string[] | undefined {
  const tsc = localBinary(cwd, "tsc");
  if (tsc && (scripts.typecheck?.includes("tsc") || existsSync(resolve(cwd, "tsconfig.json")))) {
    return [tsc, "--noEmit"];
  }
  return scripts.typecheck ? packageManagerCommand(cwd, "typecheck", []) : undefined;
}

function processSummary(check: QualityResult["check"], result: ProcessResult): string {
  if (result.timedOut) {
    return `${check} timed out.`;
  }
  if (result.outputLimitExceeded) {
    return `${check} output exceeded the configured limit.`;
  }
  return result.exitCode === 0 ? `${check} passed.` : `${check} failed with exit code ${result.exitCode}.`;
}

function buildQualityAction(check: QualityResult["check"]): ActionDefinition<
  z.infer<typeof QualityInputSchema>,
  QualityResult
> {
  return {
    manifest: {
      id: `quality.${check}`,
      version: 1,
      description: `Run the repository ${check} command with bounded output.`,
      handler: `@shadow/actions/quality/${check}`,
      inputSchema: "quality_input_v1",
      outputSchema: "quality_result_v1",
      risk: "read_only",
      timeoutMs: 300_000,
      maxOutputBytes: 2_000_000,
      network: false,
      writesWorkspace: false,
      writesOutsideWorkspace: false,
      deploys: false,
      touchesSecrets: false,
      idempotent: true
    },
    input: QualityInputSchema,
    output: QualityResultSchema,
    async run(input, context: ActionHandlerContext) {
      const scripts = await loadPackageScripts(context.cwd);
      const command = check === "test"
        ? testCommand(context.cwd, scripts, input.selectors)
        : typecheckCommand(context.cwd, scripts);

      if (!command) {
        return {
          summary: `No ${check} command is configured.`,
          output: { check, status: "not_configured" },
          commands: [],
          exitCode: 0
        };
      }

      let result: ProcessResult;
      try {
        result = await context.execute(command);
      } catch (error) {
        // The executable itself could not be started.
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: `${check} command could not be started: ${message}`,
          output: { check, status: "unavailable", command },
          commands: [command],
          exitCode: 0,
          stderr: message
        };
      }
      // Exit 127 is the shell's "command not found": the runner is not installed. That
      // is an environment fact, not evidence about the code, and must not be fed back
      // into a remediation cycle as a test failure.
      if (result.exitCode === 127) {
        return {
          summary: `${check} runner is not installed (${command[0]} exited 127).`,
          output: { check, status: "unavailable", command },
          commands: [command],
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr
        };
      }
      const status = result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded
        ? "passed"
        : "failed";
      return {
        summary: processSummary(check, result),
        output: { check, status, command },
        commands: [command],
        exitCode: status === "passed" ? 0 : result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  };
}

export const testAction = buildQualityAction("test");
export const typecheckAction = buildQualityAction("typecheck");
