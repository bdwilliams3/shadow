import { z } from "zod";
import type { ArtifactReference, ToolCallRecord } from "../orchestration/types.js";
import { RiskClassSchema } from "../policies/policy.js";

export const ActionManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/),
    version: z.number().int().positive(),
    description: z.string().min(1),
    handler: z.string().min(1).optional(),
    fallbackCommand: z.array(z.string()).min(1).optional(),
    inputSchema: z.string().min(1),
    outputSchema: z.string().min(1),
    risk: RiskClassSchema,
    timeoutMs: z.number().int().positive().default(300_000),
    maxOutputBytes: z.number().int().positive().default(1_000_000),
    network: z.boolean().default(false),
    writesWorkspace: z.boolean().default(false),
    writesOutsideWorkspace: z.boolean().default(false),
    deploys: z.boolean().default(false),
    touchesSecrets: z.boolean().default(false),
    idempotent: z.boolean().default(true)
  })
  .refine((manifest) => manifest.handler !== undefined || manifest.fallbackCommand !== undefined, {
    message: "an action must declare a handler or fallback command"
  });

export type ActionManifest = z.infer<typeof ActionManifestSchema>;

export interface ProcessResult {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export interface ActionHandlerResult<TOutput> {
  summary: string;
  output: TOutput;
  commands?: string[][];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ActionHandlerContext {
  workspaceRoot: string;
  cwd: string;
  signal: AbortSignal;
  execute(command: string[], options?: { cwd?: string; stdin?: string }): Promise<ProcessResult>;
}

export interface ActionDefinition<TInput = unknown, TOutput = unknown> {
  manifest: ActionManifest;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  run(input: TInput, context: ActionHandlerContext): Promise<ActionHandlerResult<TOutput>>;
}

export interface ActionRunOptions {
  cwd?: string;
  dryRun?: boolean;
  approved?: boolean;
  allowWorkspaceWrites?: boolean;
}

export interface ActionRunResult<TOutput = unknown> {
  record: ToolCallRecord;
  output?: TOutput;
  artifacts: ArtifactReference[];
}
