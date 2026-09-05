import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { LifecycleOrchestrator } from "../src/orchestration/orchestrator.js";
import { SQLitePersistenceStore } from "../src/persistence/sqlite-store.js";

describe("LifecycleOrchestrator", () => {
  it("creates an auditable completed dry run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-run-"));
    const store = new SQLitePersistenceStore(join(workspace, ".shadow/shadow.db"));
    const orchestrator = new LifecycleOrchestrator(defaultConfig, store);

    const run = await orchestrator.run({
      request: "fix a typo",
      workspaceRoot: workspace,
      dryRun: true
    });

    expect(run.state).toBe("COMPLETED");
    expect(run.stageRuns.map((stage) => stage.stage)).toEqual(["plan", "develop", "test", "validate"]);
    expect(run.stageRuns[0]?.status).toBe("completed");
    expect(run.stageRuns[1]?.status).toBe("skipped");
    expect(run.stageRuns[2]?.status).toBe("skipped");
    expect(run.stageRuns[3]?.status).toBe("completed");
    expect(run.stageRuns.flatMap((stage) => stage.result?.toolCalls ?? []).length).toBeGreaterThan(0);

    const persisted = await store.getRun(run.id);
    expect(persisted?.id).toBe(run.id);
  });
});
