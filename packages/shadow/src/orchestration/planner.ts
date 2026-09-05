import { randomUUID } from "node:crypto";
import type { ShadowConfig } from "../config/schema.js";
import type { StageName, StageTask } from "./types.js";

export interface PlannedWorkflow {
  stages: StageTask[];
  /** Run-level invariants recorded for audit. They are not the task's acceptance criteria. */
  invariants: string[];
  risks: string[];
}

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
  // persistence, budgeting, and policy-evaluation components". Real per-task criteria
  // require a model-backed Plan stage, which does not exist yet; until then stage tasks
  // carry none and agents receive only the request.
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
    stages: enabled.map((stage) => ({
      id: randomUUID(),
      runId,
      stage,
      goal: request,
      inputs: [],
      constraints: [
        "Do not pass entire chat transcripts between stages.",
        "Persist structured stage results and audit events."
      ],
      allowedTools:
        stage === "plan"
          ? ["repository.inspect"]
          : stage === "design"
            ? ["context.select"]
          : stage === "develop"
            ? ["context.select", "context.verify", "git.status", "patch.check", "patch.apply"]
            : stage === "test"
              ? ["git.status", "tests.select", "mcp.tests.run_tests", "quality.test"]
              : stage === "validate"
                ? ["git.status", "quality.typecheck", "security.secrets", "security.dependencies"]
                : stage === "deploy"
                  ? ["deploy.execute", "deploy.rollback"]
                : stage === "document"
                  ? ["context.select", "context.verify", "patch.check", "patch.apply"]
                : [],
      writePermissions: (stage === "develop" || stage === "deploy" || stage === "document") && !dryRun,
      acceptanceCriteria: [],
      budget: config.budgets.stage,
      retryCount: 0
    })),
    invariants,
    risks
  };
}
