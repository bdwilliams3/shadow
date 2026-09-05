import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunSchema, type Run } from "../src/orchestration/types.js";
import { FilePersistenceStore } from "../src/persistence/store.js";
import {
  openSQLitePersistenceStore,
  SQLitePersistenceStore
} from "../src/persistence/sqlite-store.js";

function exampleRun(id = "run-1"): Run {
  const now = new Date().toISOString();
  return RunSchema.parse({
    id,
    workspaceRoot: "/tmp/example",
    request: "make a bounded change",
    state: "PLANNED",
    createdAt: now,
    updatedAt: now
  });
}

describe("SQLitePersistenceStore", () => {
  it("persists runs and returns events in insertion order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-sqlite-"));
    const path = join(workspace, ".shadow/shadow.db");
    const store = new SQLitePersistenceStore(path);
    const run = exampleRun();

    await store.createRun(run);
    await store.appendEvent(run.id, "stage.started", { stage: "plan" });
    run.state = "EXECUTING";
    run.updatedAt = new Date().toISOString();
    await store.updateRun(run);

    expect((await store.getRun(run.id))?.state).toBe("EXECUTING");
    expect((await store.listRuns()).map((candidate) => candidate.id)).toEqual([run.id]);
    expect((await store.listEvents(run.id)).map((event) => event.type)).toEqual([
      "run.created",
      "stage.started",
      "run.updated"
    ]);
    store.close();
  });

  it("does not let a stale writer overwrite cross-process cancellation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-sqlite-"));
    const path = join(workspace, ".shadow/shadow.db");
    const orchestratorStore = new SQLitePersistenceStore(path);
    const controlStore = new SQLitePersistenceStore(path);
    const run = exampleRun();
    await orchestratorStore.createRun(run);
    const stale = await orchestratorStore.getRun(run.id);

    await controlStore.requestCancellation(run.id);
    stale!.state = "EXECUTING";
    await orchestratorStore.updateRun(stale!);

    expect((await controlStore.getRun(run.id))?.state).toBe("CANCELLED");
    expect((await controlStore.listEvents(run.id)).map((event) => event.type)).toContain(
      "run.cancelled"
    );
    orchestratorStore.close();
    controlStore.close();
  });

  it("imports legacy JSON and JSONL records once", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-sqlite-"));
    const runsDir = join(workspace, ".shadow/runs");
    const legacy = new FilePersistenceStore(runsDir);
    const run = exampleRun("legacy-run");
    await legacy.createRun(run);
    await legacy.appendEvent(run.id, "legacy.event", { imported: true });

    const store = await openSQLitePersistenceStore(
      join(workspace, ".shadow/shadow.db"),
      runsDir
    );

    expect((await store.getRun(run.id))?.id).toBe(run.id);
    expect((await store.listEvents(run.id)).map((event) => event.type)).toEqual([
      "run.created",
      "legacy.event"
    ]);
    expect(await store.importLegacyRuns(runsDir)).toBe(0);
    store.close();
  });
});
