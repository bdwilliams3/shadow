import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ShadowConfig } from "../config/schema.js";
import type { ArtifactReference, ToolCallRecord } from "../orchestration/types.js";
import { evaluatePolicy } from "../policies/policy.js";
import { executeProcess } from "./process.js";
import type { ActionRunOptions, ActionRunResult } from "./types.js";
import type { ActionRegistry } from "./registry.js";

export class ActionRunner {
  constructor(
    readonly registry: ActionRegistry,
    private readonly workspaceRoot: string,
    private readonly config: ShadowConfig,
    private readonly artifactStore: ArtifactStore,
    private readonly externalSignal?: AbortSignal
  ) {}

  async run<TOutput = unknown>(
    actionId: string,
    rawInput: unknown,
    options: ActionRunOptions = {}
  ): Promise<ActionRunResult<TOutput>> {
    const startedAt = performance.now();
    const definition = this.registry.get(actionId);
    if (!definition) {
      throw new Error(`Unknown action: ${actionId}`);
    }

    const requestedCwd = resolve(this.workspaceRoot, options.cwd ?? ".");
    const [workspaceRoot, cwd] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(requestedCwd)
    ]);
    this.assertInsideWorkspace(workspaceRoot, cwd);
    const manifest = definition.manifest;
    if (this.externalSignal?.aborted) {
      return this.terminalResult(manifest.id, manifest.version, cwd, startedAt, "failed", {
        summary: "Action cancelled.",
        approvalRequired: false
      });
    }
    const policy = evaluatePolicy(
      {
        id: manifest.id,
        description: manifest.description,
        risk: manifest.risk,
        writesWorkspace: manifest.writesWorkspace,
        writesOutsideWorkspace: manifest.writesOutsideWorkspace,
        usesNetwork: manifest.network,
        deploys: manifest.deploys,
        touchesSecrets: manifest.touchesSecrets
      },
      this.config
    );

    if (!policy.allowed) {
      return this.terminalResult(manifest.id, manifest.version, cwd, startedAt, "blocked", {
        summary: `Policy blocked action: ${policy.reasons.join(", ")}`,
        approvalRequired: policy.requiresApproval
      });
    }
    if (policy.requiresApproval && !options.approved) {
      return this.terminalResult(manifest.id, manifest.version, cwd, startedAt, "blocked", {
        summary: `Action requires approval: ${policy.reasons.join(", ") || manifest.risk}`,
        approvalRequired: true
      });
    }
    if (options.dryRun && manifest.writesWorkspace) {
      return this.terminalResult(manifest.id, manifest.version, cwd, startedAt, "skipped", {
        summary: "Dry run skipped a workspace-writing action.",
        approvalRequired: false
      });
    }
    if (manifest.writesWorkspace && !options.allowWorkspaceWrites) {
      return this.terminalResult(manifest.id, manifest.version, cwd, startedAt, "blocked", {
        summary: "The current stage did not grant workspace-write permission.",
        approvalRequired: false
      });
    }

    const input = definition.input.parse(rawInput);
    const controller = new AbortController();
    const artifacts: ArtifactReference[] = [];
    const executedCommands: string[][] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let rejectCancellation: (reason: Error) => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (): void => {
      controller.abort();
      rejectCancellation(new Error("Action cancelled."));
    };
    this.externalSignal?.addEventListener("abort", cancel, { once: true });

    try {
      const execution = definition.run(input, {
        workspaceRoot,
        cwd,
        signal: controller.signal,
        execute: (command, commandOptions = {}) => {
          executedCommands.push(command);
          return executeProcess(command, {
            workspaceRoot,
            cwd: commandOptions.cwd ?? cwd,
            timeoutMs: manifest.timeoutMs,
            maxOutputBytes: manifest.maxOutputBytes,
            signal: controller.signal,
            ...(commandOptions.stdin === undefined ? {} : { stdin: commandOptions.stdin })
          });
        }
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`Action timed out after ${manifest.timeoutMs}ms`));
        }, manifest.timeoutMs);
      });
      const result = await Promise.race([execution, deadline, cancelled]);
      const output = definition.output.parse(result.output) as TOutput;

      if (result.stdout) {
        artifacts.push(await this.artifactStore.writeText("action.stdout", `${actionId}.stdout.log`, result.stdout));
      }
      if (result.stderr) {
        artifacts.push(await this.artifactStore.writeText("action.stderr", `${actionId}.stderr.log`, result.stderr));
      }
      artifacts.push(
        await this.artifactStore.writeText(
          "action.result",
          `${actionId}.result.json`,
          `${JSON.stringify(output, null, 2)}\n`
        )
      );

      const status = result.exitCode === undefined || result.exitCode === 0 ? "completed" : "failed";
      return {
        record: {
          actionId,
          actionVersion: manifest.version,
          status,
          cwd,
          commands: result.commands ?? executedCommands,
          exitCode: result.exitCode,
          durationMs: Math.round(performance.now() - startedAt),
          summary: result.summary,
          approvalRequired: false,
          artifacts
        },
        output,
        artifacts
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.terminalResult(manifest.id, manifest.version, cwd, startedAt, "failed", {
        summary: timedOut
          ? `Action timed out after ${manifest.timeoutMs}ms`
          : controller.signal.aborted
            ? "Action cancelled."
            : message,
        approvalRequired: false,
        commands: executedCommands
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.externalSignal?.removeEventListener("abort", cancel);
    }
  }

  private terminalResult(
    actionId: string,
    actionVersion: number,
    cwd: string,
    startedAt: number,
    status: ToolCallRecord["status"],
    details: Pick<ToolCallRecord, "summary" | "approvalRequired"> & { commands?: string[][] }
  ): ActionRunResult<never> {
    return {
      record: {
        actionId,
        actionVersion,
        status,
        cwd,
        commands: details.commands ?? [],
        durationMs: Math.round(performance.now() - startedAt),
        summary: details.summary,
        approvalRequired: details.approvalRequired,
        artifacts: []
      },
      artifacts: []
    };
  }

  private assertInsideWorkspace(workspaceRoot: string, path: string): void {
    const candidate = relative(workspaceRoot, path);
    if (candidate === ".." || candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Action working directory is outside the workspace: ${path}`);
    }
  }
}
