import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

describe("loadConfig", () => {
  it("loads defaults when no repo config exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    const { config, sources } = await loadConfig(workspace);

    expect(sources).toEqual([]);
    expect(config.agents.plan).toBe("frontier");
    expect(config.lifecycle.enabledStages).toContain("develop");
    expect(config.persistence.databasePath).toBe(".shadow/shadow.db");
    expect(config.mcp.tests.enabled).toBe(true);
    expect(config.workspace.exclusions).toEqual([]);
  });

  it("merges repository config over defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-config-"));
    await mkdir(join(workspace, ".shadow"), { recursive: true });
    await writeFile(
      join(workspace, ".shadow/config.yaml"),
      "lifecycle:\n  maxStageRetries: 3\nagents:\n  develop: economy\n",
      "utf8"
    );

    const { config, sources } = await loadConfig(workspace);

    expect(sources).toContain(join(workspace, ".shadow/config.yaml"));
    expect(config.lifecycle.maxStageRetries).toBe(3);
    expect(config.agents.develop).toBe("economy");
    expect(config.agents.plan).toBe("frontier");
  });
});
