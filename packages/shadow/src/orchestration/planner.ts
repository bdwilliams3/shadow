import { randomUUID } from "node:crypto";
import type { ShadowConfig } from "../config/schema.js";
import type { Budget, StageName, StageTask } from "./types.js";

export interface PlannedWorkflow {
  stages: StageTask[];
  /** Run-level invariants recorded for audit. They are not the task's acceptance criteria. */
  invariants: string[];
  risks: string[];
}

/**
 * Tools a stage may use. This table is the authority for both the deterministic bootstrap
 * graph and any revision the Plan stage proposes: a plan may choose *which* stages run and
 * what they must achieve, never what they are permitted to touch.
 */
export function allowedToolsFor(stage: StageName): string[] {
  switch (stage) {
    case "plan":
      return ["repository.inspect", "git.status"];
    case "design":
      return ["context.select"];
    case "develop":
      return ["context.select", "context.verify", "git.status", "patch.check", "patch.apply"];
    case "test":
      return ["git.status", "tests.select", "mcp.tests.run_tests", "quality.test"];
    case "validate":
      return ["git.status", "quality.typecheck", "security.secrets", "security.dependencies"];
    case "deploy":
      return ["deploy.execute", "deploy.rollback"];
    case "document":
      return ["context.select", "context.verify", "patch.check", "patch.apply"];
    default:
      return [];
  }
}

/**
 * Stages backed by a model. Plan, Design, Develop, and Document reach a provider; Test,
 * Validate, and Deploy are deterministic and their configured tier is never consulted.
 */
const modelBackedStages = new Set<StageName>(["plan", "design", "develop", "document"]);

export function stageCallsModel(stage: StageName): boolean {
  return modelBackedStages.has(stage);
}

/** Write permission is a property of the stage and the run, never of a model's proposal. */
export function writePermissionsFor(stage: StageName, dryRun: boolean): boolean {
  return (stage === "develop" || stage === "deploy" || stage === "document") && !dryRun;
}

const sharedConstraints = [
  "Do not pass entire chat transcripts between stages.",
  "Persist structured stage results and audit events."
];

export interface StageTaskInput {
  runId: string;
  stage: StageName;
  goal: string;
  budget: Budget;
  dryRun: boolean;
  acceptanceCriteria?: string[];
  id?: string;
}

export function createStageTask(input: StageTaskInput): StageTask {
  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    stage: input.stage,
    goal: input.goal,
    inputs: [],
    constraints: [...sharedConstraints],
    allowedTools: allowedToolsFor(input.stage),
    writePermissions: writePermissionsFor(input.stage, input.dryRun),
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    budget: input.budget,
    retryCount: 0
  };
}

/**
 * The deterministic bootstrap graph. A run needs durable stage tasks before any stage
 * executes, so this keyword classification runs first and the model-backed Plan stage
 * revises what remains. It is also the fallback when Plan cannot reach a model.
 */
export function planWorkflow(
  runId: string,
  request: string,
  config: ShadowConfig,
  dryRun: boolean
): PlannedWorkflow {
  const normalized = request.toLowerCase();
  const deployRequested = /\b(deploy|release|publish)\b/.test(normalized);
  const docsOnly = /\b(doc|docs|readme|documentation)\b/.test(normalized) && !/\b(code|implement|fix)\b/.test(normalized);
  const newProject = /\b(new project|create project|scaffold)\b/.test(normalized);

  const desiredStages: StageName[] = docsOnly
    ? ["plan", "document", "validate"]
    : deployRequested
      ? ["plan", "design", "develop", "test", "validate", "deploy", "document"]
      : newProject
        ? ["plan", "design", "develop", "test", "validate", "document"]
        : ["plan", "develop", "test", "validate"];

  const enabled = desiredStages.filter((stage) => config.lifecycle.enabledStages.includes(stage));
  // These describe Shadow, not the user's change. Handing them to a model as the task's
  // acceptance criteria made it decline ordinary edits for lacking "orchestration,
  // persistence, budgeting, and policy-evaluation components". They stay run-level audit
  // records; per-task criteria come from the model-backed Plan stage.
  const invariants = [
    "The requested work is represented as a durable run.",
    "Each selected lifecycle stage records a structured result.",
    "Token and cost budgets are checked before model-backed work.",
    "Risky actions require policy evaluation before execution."
  ];

  const risks = dryRun
    ? ["Dry run requested; no workspace-changing actions will be executed."]
    : [];

  return {
    stages: enabled.map((stage) =>
      createStageTask({
        runId,
        stage,
        goal: request,
        budget: config.budgets.stage,
        dryRun
      })
    ),
    invariants,
    risks
  };
}
