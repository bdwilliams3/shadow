import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  RunEventSchema,
  RunSchema,
  type Run,
  type RunEvent
} from "../orchestration/types.js";
import type { PersistenceStore } from "./store.js";

interface RunRow {
  run_json: string;
}

interface EventRow {
  id: string;
  run_id: string;
  type: string;
  created_at: string;
  payload_json: string;
}

export class SQLitePersistenceStore implements PersistenceStore {
  private readonly database: DatabaseSync;
  private readonly selectRun: StatementSync;
  private readonly upsertRun: StatementSync;
  private readonly selectRuns: StatementSync;
  private readonly selectEvents: StatementSync;
  private readonly insertEvent: StatementSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        request TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);

    this.selectRun = this.database.prepare("SELECT run_json FROM runs WHERE id = ?");
    this.upsertRun = this.database.prepare(`
      INSERT INTO runs (id, state, workspace_root, request, created_at, updated_at, run_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        workspace_root = excluded.workspace_root,
        request = excluded.request,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        run_json = excluded.run_json
    `);
    this.selectRuns = this.database.prepare("SELECT run_json FROM runs ORDER BY created_at DESC");
    this.selectEvents = this.database.prepare(`
      SELECT id, run_id, type, created_at, payload_json
      FROM events
      WHERE run_id = ?
      ORDER BY sequence
    `);
    this.insertEvent = this.database.prepare(`
      INSERT INTO events (id, run_id, type, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  async createRun(run: Run): Promise<void> {
    this.transaction(() => {
      if (this.readRun(run.id)) {
        throw new Error(`Run ${run.id} already exists.`);
      }
      this.writeRun(run);
      this.writeEvent(this.newEvent(run.id, "run.created", { state: run.state }));
    });
  }

  async updateRun(run: Run): Promise<void> {
    this.transaction(() => {
      const existing = this.readRun(run.id);
      if (existing?.cancellationRequestedAt) {
        run.cancellationRequestedAt = existing.cancellationRequestedAt;
        run.state = "CANCELLED";
      }
      if (existing) {
        const approvals = new Map(existing.approvals.map((approval) => [approval.id, approval]));
        run.approvals = run.approvals.map((approval) => {
          const persisted = approvals.get(approval.id);
          return persisted && persisted.status !== "pending" ? persisted : approval;
        });
      }
      this.writeRun(run);
      this.writeEvent(this.newEvent(run.id, "run.updated", { state: run.state }));
    });
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return this.readRun(runId);
  }

  async listRuns(): Promise<Run[]> {
    return (this.selectRuns.all() as unknown as RunRow[]).map((row) => this.parseRun(row));
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return (this.selectEvents.all(runId) as unknown as EventRow[]).map((row) =>
      RunEventSchema.parse({
        id: row.id,
        runId: row.run_id,
        type: row.type,
        createdAt: row.created_at,
        payload: JSON.parse(row.payload_json) as unknown
      })
    );
  }

  async appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<RunEvent> {
    const event = this.newEvent(runId, type, payload);
    this.transaction(() => this.writeEvent(event));
    return event;
  }

  async requestCancellation(runId: string): Promise<Run | undefined> {
    return this.transaction(() => {
      const run = this.readRun(runId);
      if (!run || run.state === "COMPLETED" || run.state === "FAILED" || run.state === "CANCELLED") {
        return run;
      }
      const requestedAt = new Date().toISOString();
      run.cancellationRequestedAt = requestedAt;
      run.state = "CANCELLED";
      run.updatedAt = requestedAt;
      for (const stage of run.stageRuns) {
        if (stage.status === "running") {
          stage.status = "cancelled";
          stage.completedAt = requestedAt;
        }
      }
      this.writeRun(run);
      this.writeEvent(this.newEvent(run.id, "run.cancelled", { requestedAt }));
      return run;
    });
  }

  async resolveApproval(
    runId: string,
    approvalId: string | undefined,
    decision: "approved" | "rejected"
  ): Promise<Run | undefined> {
    return this.transaction(() => {
      const run = this.readRun(runId);
      if (!run) {
        return undefined;
      }
      const approval = approvalId
        ? run.approvals.find((candidate) => candidate.id === approvalId && candidate.status === "pending")
        : run.approvals.find((candidate) => candidate.status === "pending");
      if (!approval) {
        return run;
      }
      const resolvedAt = new Date().toISOString();
      approval.status = decision;
      approval.resolvedAt = resolvedAt;
      run.updatedAt = resolvedAt;
      if (decision === "rejected") {
        run.cancellationRequestedAt = resolvedAt;
        run.state = "CANCELLED";
      }
      this.writeRun(run);
      this.writeEvent(
        this.newEvent(run.id, "approval.resolved", {
          approvalId: approval.id,
          operation: approval.operation,
          decision
        })
      );
      return run;
    });
  }

  async importLegacyRuns(runsDir: string): Promise<number> {
    const migrationKey = `legacy-file-store-v1:${resolve(runsDir)}`;
    const migrated = this.database
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(migrationKey) as { value: string } | undefined;
    if (migrated) {
      return 0;
    }

    let imported = 0;
    if (existsSync(runsDir)) {
      const entries = await readdir(runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || this.readRun(entry.name)) {
          continue;
        }
        const runPath = resolve(runsDir, entry.name, "run.json");
        if (!existsSync(runPath)) {
          continue;
        }
        const run = RunSchema.parse(JSON.parse(await readFile(runPath, "utf8")));
        const eventsPath = resolve(runsDir, entry.name, "events.jsonl");
        const events = existsSync(eventsPath)
          ? (await readFile(eventsPath, "utf8"))
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => RunEventSchema.parse(JSON.parse(line)))
          : [];
        this.transaction(() => {
          this.writeRun(run);
          for (const event of events) {
            this.writeEvent(event);
          }
        });
        imported += 1;
      }
    }

    this.database
      .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      .run(migrationKey, new Date().toISOString());
    return imported;
  }

  close(): void {
    this.database.close();
  }

  private readRun(runId: string): Run | undefined {
    const row = this.selectRun.get(runId) as unknown as RunRow | undefined;
    return row ? this.parseRun(row) : undefined;
  }

  private parseRun(row: RunRow): Run {
    return RunSchema.parse(JSON.parse(row.run_json));
  }

  private writeRun(run: Run): void {
    const parsed = RunSchema.parse(run);
    this.upsertRun.run(
      parsed.id,
      parsed.state,
      parsed.workspaceRoot,
      parsed.request,
      parsed.createdAt,
      parsed.updatedAt,
      JSON.stringify(parsed)
    );
  }

  private newEvent(runId: string, type: string, payload: Record<string, unknown>): RunEvent {
    return RunEventSchema.parse({
      id: randomUUID(),
      runId,
      type,
      createdAt: new Date().toISOString(),
      payload
    });
  }

  private writeEvent(event: RunEvent): void {
    this.insertEvent.run(
      event.id,
      event.runId,
      event.type,
      event.createdAt,
      JSON.stringify(event.payload)
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function openSQLitePersistenceStore(
  databasePath: string,
  legacyRunsDir?: string
): Promise<SQLitePersistenceStore> {
  const store = new SQLitePersistenceStore(databasePath);
  if (legacyRunsDir) {
    await store.importLegacyRuns(legacyRunsDir);
  }
  return store;
}
