import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeProcess } from "../src/tools/process.js";

describe("executeProcess", () => {
  it("escalates to SIGKILL when a timed-out child ignores SIGTERM", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-process-"));
    // Traps SIGTERM and idles forever; only SIGKILL can end it.
    const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const startedAt = performance.now();

    const result = await executeProcess(["node", "-e", stubborn], {
      workspaceRoot: workspace,
      cwd: workspace,
      timeoutMs: 200,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // Grace period is 5 s; well under that plus the timeout means the kill landed.
    expect(performance.now() - startedAt).toBeLessThan(9_000);
  }, 15_000);

  it("returns promptly when a child honors SIGTERM", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-process-"));
    const startedAt = performance.now();

    const result = await executeProcess(["node", "-e", "setInterval(() => {}, 1000);"], {
      workspaceRoot: workspace,
      cwd: workspace,
      timeoutMs: 200,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal
    });

    expect(result.timedOut).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(4_000);
  });
});
