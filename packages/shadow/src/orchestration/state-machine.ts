import type { RunState, StageName } from "./types.js";

const stateByStage: Record<StageName, RunState> = {
  plan: "PLANNED",
  design: "EXECUTING",
  develop: "EXECUTING",
  test: "TESTING",
  validate: "VALIDATING",
  deploy: "DEPLOYING",
  document: "DOCUMENTING"
};

const allowedTransitions: Record<RunState, RunState[]> = {
  RECEIVED: ["CLASSIFIED", "FAILED", "CANCELLED"],
  CLASSIFIED: ["PLANNED", "FAILED", "CANCELLED"],
  PLANNED: ["EXECUTING", "TESTING", "VALIDATING", "DOCUMENTING", "COMPLETED", "FAILED", "CANCELLED"],
  EXECUTING: ["TESTING", "VALIDATING", "DEPLOYING", "DOCUMENTING", "COMPLETED", "AWAITING_APPROVAL", "FAILED", "CANCELLED"],
  TESTING: ["EXECUTING", "VALIDATING", "FAILED", "CANCELLED"],
  VALIDATING: ["DEPLOYING", "DOCUMENTING", "COMPLETED", "FAILED", "CANCELLED"],
  AWAITING_APPROVAL: ["PLANNED", "EXECUTING", "TESTING", "VALIDATING", "DEPLOYING", "DOCUMENTING", "FAILED", "CANCELLED"],
  DEPLOYING: ["DOCUMENTING", "COMPLETED", "FAILED", "CANCELLED"],
  DOCUMENTING: ["VALIDATING", "COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
};

export function stateForStage(stage: StageName): RunState {
  return stateByStage[stage];
}

export function canTransition(from: RunState, to: RunState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to) && from !== to) {
    throw new Error(`Invalid run transition from ${from} to ${to}`);
  }
}
