import { describe, expect, it } from "vitest";
import { ChatOrchestratorAgent } from "../src/agents/chat-orchestrator-agent.js";
import { defaultConfig } from "../src/config/defaults.js";
import { ModelRouter } from "../src/models/router.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/models/provider.js";

describe("ChatOrchestratorAgent", () => {
  it("routes read-only discussion through the configured coordinator model", async () => {
    const seen: ModelRequest[] = [];
    const provider: ModelProvider = {
      async complete(request): Promise<ModelResponse> {
        seen.push(request);
        return {
          text: JSON.stringify({
            decision: "keep_thinking",
            reply: "Hi, I'm Shadow. This repo is the CLI harness.",
            confidence: "high"
          }),
          usage: { inputTokens: 30, outputTokens: 12, estimatedCostUsd: 0.001 }
        };
      }
    };
    const config = structuredClone(defaultConfig);
    config.agents.chat = "fable-5-1";
    const agent = new ChatOrchestratorAgent(
      new ModelRouter(config, new Map([["anthropic", provider]])),
      config.agents.chat,
      config.budgets.stage
    );

    const result = await agent.run({
      message: "what can we do here?",
      workspaceRoot: "/tmp/repo",
      repositorySummary: "Shadow is a local command-line coding-agent harness.",
      highestPriorityNextStep: "Continue the command-line chatbox product slice.",
      changedFileCount: 3,
      steeringNotes: ["stay read-only"]
    });

    expect(result).toMatchObject({
      decision: "keep_thinking",
      reply: "Hi, I'm Shadow. This repo is the CLI harness."
    });
    expect(seen[0]?.tier).toBe("fable-5-1");
    expect(seen[0]?.outputSchema?.name).toBe("shadow_chat_orchestrator_v1");
  });
});
