import type { ShadowConfig } from "./schema.js";

export const defaultConfig: ShadowConfig = {
  version: 1,
  providers: {
    openai: {
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: {
        "gpt-6-astra": {
          model: "gpt-6-astra",
          maxOutputTokens: 128_000,
          inputCostPerMillionTokens: 10.00,
          outputCostPerMillionTokens: 50.00,
          reservedBudget: true
        },
        "gpt-5-6-sol": {
          model: "gpt-5.6-sol",
          maxOutputTokens: 12_000,
          inputCostPerMillionTokens: 4.00,
          outputCostPerMillionTokens: 20.00,
          reservedBudget: true
        },
        "gpt-5-6-luna": {
          model: "gpt-5.6-luna",
          maxOutputTokens: 128_000,
          inputCostPerMillionTokens: 0.20,
          outputCostPerMillionTokens: 1.20,
          reservedBudget: false
        },
        "gpt-5-5": {
          model: "gpt-5.5",
          maxOutputTokens: 6_000,
          inputCostPerMillionTokens: 2.00,
          outputCostPerMillionTokens: 12.00,
          reservedBudget: false
        },
        "gpt-5-4-mini": {
          model: "gpt-5.4-mini",
          maxOutputTokens: 3_000,
          inputCostPerMillionTokens: 0.20,
          outputCostPerMillionTokens: 1.20,
          reservedBudget: false
        }
      },
      structuredOutput: true,
      maxCompletionTokensParam: true,
      requestTimeoutMs: 120_000
    },
    anthropic: {
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: {
        "fable-5-1": {
          model: "fable-5.1",
          maxOutputTokens: 120_000,
          inputCostPerMillionTokens: 3,
          outputCostPerMillionTokens: 15,
          reservedBudget: true
        },
        "opus-4-8": {
          model: "opus-4.8",
          maxOutputTokens: 64_000,
          inputCostPerMillionTokens: 15,
          outputCostPerMillionTokens: 75,
          reservedBudget: true
        },
        "sonnet-4-6": {
          model: "sonnet-4.6",
          maxOutputTokens: 64_000,
          inputCostPerMillionTokens: 3,
          outputCostPerMillionTokens: 15,
          reservedBudget: false
        },
        "haiku-4-5": {
          model: "haiku-4.5",
          maxOutputTokens: 32_000,
          inputCostPerMillionTokens: 1,
          outputCostPerMillionTokens: 5,
          reservedBudget: false
        }
      },
      structuredOutput: false,
      maxCompletionTokensParam: true,
      requestTimeoutMs: 120_000
    },
    google: {
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKeyEnv: "GEMINI_API_KEY",
      models: {
        "gemini-3-8": {
          model: "gemini-3.8",
          maxOutputTokens: 64_000,
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 10,
          reservedBudget: true
        },
        "gemini-3-8-flash": {
          model: "gemini-3.8-flash",
          maxOutputTokens: 65_536,
          inputCostPerMillionTokens: 0.75,
          outputCostPerMillionTokens: 3.75,
          reservedBudget: true
        },
        "gemini-3-5-flash": {
          model: "gemini-3.5-flash",
          maxOutputTokens: 65_536,
          inputCostPerMillionTokens: 1.5,
          outputCostPerMillionTokens: 9,
          reservedBudget: false
        },
        "gemini-3-1-pro-preview": {
          model: "gemini-3.1-pro-preview",
          maxOutputTokens: 65_536,
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 12,
          reservedBudget: true
        },
        "gemini-3-1-flash-lite": {
          model: "gemini-3.1-flash-lite",
          maxOutputTokens: 65_536,
          inputCostPerMillionTokens: 0.25,
          outputCostPerMillionTokens: 1.5,
          reservedBudget: false
        },
        "gemini-2-5": {
          model: "gemini-2.5",
          maxOutputTokens: 64_000,
          inputCostPerMillionTokens: 1,
          outputCostPerMillionTokens: 5,
          reservedBudget: false
        },
        "gemini-2-5-flash": {
          model: "gemini-2.5-flash",
          maxOutputTokens: 65_536,
          inputCostPerMillionTokens: 0.3,
          outputCostPerMillionTokens: 2.5,
          reservedBudget: false
        }
      },
      structuredOutput: true,
      maxCompletionTokensParam: true,
      requestTimeoutMs: 120_000
    }
  },
  models: {},
  agents: {
    chat: "fable-5-1",
    plan: "fable-5-1",
    design: "gemini-3-8",
    develop: "sonnet-4-6",
    test: "haiku-4-5",
    validate: "gemini-2-5",
    deploy: "opus-4-8",
    document: "haiku-4-5"
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
