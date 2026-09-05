import type { ShadowConfig } from "./schema.js";

export const defaultConfig: ShadowConfig = {
  version: 1,
  providers: {
    default: {
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      structuredOutput: true,
      maxCompletionTokensParam: true,
      requestTimeoutMs: 120_000
    }
  },
  models: {
    frontier: {
      provider: "default",
      model: "frontier",
      maxOutputTokens: 12_000,
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 0
    },
    balanced: {
      provider: "default",
      model: "balanced",
      maxOutputTokens: 6_000,
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 0
    },
    economy: {
      provider: "default",
      model: "economy",
      maxOutputTokens: 3_000,
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 0
    }
  },
  agents: {
    plan: "frontier",
    design: "frontier",
    develop: "balanced",
    test: "economy",
    validate: "balanced",
    deploy: "economy",
    document: "economy"
  },
  budgets: {
    run: {
      maxInputTokens: 120_000,
      maxOutputTokens: 24_000,
      maxTotalTokens: 144_000,
      maxEstimatedCostUsd: 10,
      reservedFrontierTokens: 20_000
    },
    stage: {
      maxInputTokens: 40_000,
      maxOutputTokens: 8_000,
      maxTotalTokens: 48_000,
      maxEstimatedCostUsd: 3,
      reservedFrontierTokens: 4_000
    },
    modelCall: {
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 1,
      reservedFrontierTokens: 0
    }
  },
  lifecycle: {
    enabledStages: ["plan", "design", "develop", "test", "validate", "deploy", "document"],
    maxStageRetries: 1,
    maxModelCallsPerStage: 3,
    maxRemediationCycles: 1
  },
  workspace: {
    exclusions: []
  },
  deployment: {
    profiles: {}
  },
  approvals: {
    allowWorkspaceWrites: true,
    requireApprovalForDestructive: true,
    requireApprovalForExternalWrites: true,
    requireApprovalForNetwork: false,
    requireApprovalForDeploy: true
  },
  persistence: {
    databasePath: ".shadow/shadow.db",
    runsDir: ".shadow/runs",
    artifactsDir: ".shadow/artifacts"
  },
  mcp: {
    tests: {
      enabled: true,
      startupTimeoutMs: 5_000,
      pollIntervalMs: 100
    }
  },
  telemetry: {
    localOnly: true,
    remoteEnabled: false
  }
};
