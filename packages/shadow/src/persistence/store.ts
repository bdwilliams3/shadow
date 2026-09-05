import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  RunEventSchema,
  RunSchema,
  type Run,
  type RunEvent
} from "../orchestration/types.js";

export interface PersistenceStore {
  close?(): void;
  createRun(run: Run): Promise<void>;
  updateRun(run: Run): Promise<void>;
  getRun(runId: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  listEvents(runId: string): Promise<RunEvent[]>;
  appendEvent(runId: string, type: string, payload?: Record<string, unknown>): Promise<RunEvent>;
  requestCancellation(runId: string): Promise<Run | undefined>;
  resolveApproval(
    runId: string,
    approvalId: string | undefined,
    decision: "approved" | "rejected"
  ): Promise<Run | undefined>;
}

export class FilePersistenceStore implements PersistenceStore {
  constructor(private readonly runsDir: string) {}

  async createRun(run: Run): Promise<void> {
    await this.writeRun(run);
    await this.appendEvent(run.id, "run.created", { state: run.state });
  }

  async updateRun(run: Run): Promise<void> {
    const existing = await this.getRun(run.id);
    if (existing?.cancellationRequestedAt) {
      run.cancellationRequestedAt = existing.cancellationRequestedAt;
      run.state = "CANCELLED";
    }
    if (existing) {
      const existingApprovals = new Map(existing.approvals.map((approval) => [approval.id, approval]));
      run.approvals = run.approvals.map((approval) => {
        const persisted = existingApprovals.get(approval.id);
        return persisted && persisted.status !== "pending" ? persisted : approval;
      });
    }
    await this.writeRun(run);
    await this.appendEvent(run.id, "run.updated", { state: run.state });
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const path = this.runPath(runId);
    if (!existsSync(path)) {
      return undefined;
    }
    const raw = await readFile(path, "utf8");
    return RunSchema.parse(JSON.parse(raw));
  }

  async listRuns(): Promise<Run[]> {
    if (!existsSync(this.runsDir)) {
      return [];
    }
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const runs: Run[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const run = await this.getRun(entry.name);
      if (run) {
        runs.push(run);
      }
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const path = this.eventsPath(runId);
    if (!existsSync(path)) {
      return [];
    }
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
  }

  async appendEvent(runId: string, type: string, payload: Record<string, unknown> = {}): Promise<RunEvent> {
    const event = RunEventSchema.parse({
      id: randomUUID(),
      runId,
      type,
      createdAt: new Date().toISOString(),
      payload
    });
    const path = this.eventsPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async requestCancellation(runId: string): Promise<Run | undefined> {
    const run = await this.getRun(runId);
    if (!run) {
      return undefined;
    }
    if (run.state === "COMPLETED" || run.state === "FAILED" || run.state === "CANCELLED") {
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
    await this.writeRun(run);
    await this.appendEvent(run.id, "run.cancelled", { requestedAt });
    return run;
  }

  async resolveApproval(
    runId: string,
    approvalId: string | undefined,
    decision: "approved" | "rejected"
  ): Promise<Run | undefined> {
    const run = await this.getRun(runId);
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
    await this.writeRun(run);
    await this.appendEvent(run.id, "approval.resolved", {
      approvalId: approval.id,
      operation: approval.operation,
      decision
    });
    return run;
  }

  private async writeRun(run: Run): Promise<void> {
    const path = this.runPath(run.id);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = resolve(dirname(path), `.run-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(RunSchema.parse(run), null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private runPath(runId: string): string {
    return resolve(this.runsDir, runId, "run.json");
  }

  private eventsPath(runId: string): string {
    return resolve(this.runsDir, runId, "events.jsonl");
  }
}
