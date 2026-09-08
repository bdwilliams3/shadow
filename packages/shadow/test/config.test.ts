import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { resolveModelAlias } from "../src/config/schema.js";

describe("loadConfig", () => {
  it("loads defaults when no repo config exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    const { config, sources } = await loadConfig(workspace);

    expect(sources).toEqual([]);
    expect(config.agents.plan).toBe("fable-5-1");
    expect(resolveModelAlias(config, "fable-5-1")).toMatchObject({
      provider: "anthropic",
      model: "fable-5.1"
    });
    expect(config.lifecycle.enabledStages).toContain("develop");
    expect(config.persistence.databasePath).toBe(".shadow/shadow.db");
    expect(config.mcp.tests.enabled).toBe(true);
    expect(config.agents.chat).toBe("fable-5-1");
    expect(config.workspace.exclusions).toEqual([]);
  });

  it("merges repository config over defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    await mkdir(join(workspace, ".shadow"), { recursive: true });
    await writeFile(
      join(workspace, ".shadow/config.yaml"),
      [
        "providers:",
        "  local:",
        "    kind: mock",
        "    models:",
        "      local-develop:",
        "        model: local-develop",
        "        maxOutputTokens: 100",
        "lifecycle:",
        "  maxStageRetries: 3",
        "agents:",
        "  develop: local-develop",
        ""
      ].join("\n"),
      "utf8"
    );

    const { config, sources } = await loadConfig(workspace);

    expect(sources).toContain(join(workspace, ".shadow/config.yaml"));
    expect(config.lifecycle.maxStageRetries).toBe(3);
    expect(config.agents.develop).toBe("local-develop");
    expect(resolveModelAlias(config, "local-develop")).toMatchObject({
      provider: "local",
      model: "local-develop"
    });
    expect(config.agents.plan).toBe("fable-5-1");
  });

  it("accepts direct provider model ids in agent mappings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    await mkdir(join(workspace, ".shadow"), { recursive: true });
    await writeFile(
      join(workspace, ".shadow/config.yaml"),
      "agents:\n  plan: gpt-5.6-luna\n  develop: gpt-5.5\n",
      "utf8"
    );

    const { config } = await loadConfig(workspace);

    expect(resolveModelAlias(config, config.agents.plan)).toMatchObject({
      alias: "gpt-5-6-luna",
      provider: "openai",
      model: "gpt-5.6-luna"
    });
    expect(resolveModelAlias(config, config.agents.develop)).toMatchObject({
      alias: "gpt-5-5",
      provider: "openai",
      model: "gpt-5.5"
    });
  });

  it("rejects ambiguous direct provider model ids in agent mappings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    await mkdir(join(workspace, ".shadow"), { recursive: true });
    await writeFile(
      join(workspace, ".shadow/config.yaml"),
      [
        "providers:",
        "  duplicate:",
        "    kind: mock",
        "    models:",
        "      duplicate-gpt:",
        "        model: gpt-5.5",
        "        maxOutputTokens: 100",
        "agents:",
        "  develop: gpt-5.5",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadConfig(workspace)).rejects.toThrow(
      "stage develop references model id gpt-5.5, which is configured under multiple aliases"
    );
  });

  it("rejects an agent mapping to an undefined model alias", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    await mkdir(join(workspace, ".shadow"), { recursive: true });
    await writeFile(
      join(workspace, ".shadow/config.yaml"),
      "agents:\n  develop: missing-model\n",
      "utf8"
    );

    await expect(loadConfig(workspace)).rejects.toThrow("stage develop references unknown model alias missing-model");
  });
});
