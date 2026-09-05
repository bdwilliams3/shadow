import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import { ActionRegistry } from "../src/tools/registry.js";
import { ActionRunner } from "../src/tools/runner.js";
import type { ActionDefinition } from "../src/tools/types.js";

const OutputSchema = z.object({ value: z.string() });

function definition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    manifest: {
      id: "fixture.read",
      version: 1,
      description: "Read a fixture value.",
      handler: "fixture/read",
      inputSchema: "empty_object_v1",
      outputSchema: "fixture_output_v1",
      risk: "read_only",
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      network: false,
      writesWorkspace: false,
      writesOutsideWorkspace: false,
      deploys: false,
      touchesSecrets: false,
      idempotent: true
    },
    input: z.object({}),
    output: OutputSchema,
    async run() {
      return { summary: "fixture complete", output: { value: "ok" }, stdout: "raw output" };
    },
    ...overrides
  };
}

async function runnerFor(action: ActionDefinition, config = defaultConfig): Promise<ActionRunner> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-action-"));
  return new ActionRunner(
    new ActionRegistry().register(action),
    workspace,
    config,
    new ArtifactStore(join(workspace, ".shadow/artifacts"))
  );
}

describe("ActionRunner", () => {
  it("validates and persists normalized and raw action output", async () => {
    const runner = await runnerFor(definition());
    const result = await runner.run<{ value: string }>("fixture.read", {});

    expect(result.record.status).toBe("completed");
    expect(result.output).toEqual({ value: "ok" });
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["action.stdout", "action.result"]);
    expect(await readFile(result.artifacts[0]!.path, "utf8")).toBe("raw output");
  });

  it("rejects unknown actions", async () => {
    const runner = await runnerFor(definition());
    await expect(runner.run("fixture.unknown", {})).rejects.toThrow("Unknown action");
  });

  it("requires approval before external writes", async () => {
    const action = definition({
      manifest: {
        ...definition().manifest,
        id: "fixture.external",
        risk: "external_write"
      }
    });
    const runner = await runnerFor(action);
    const result = await runner.run("fixture.external", {});

    expect(result.record.status).toBe("blocked");
    expect(result.record.approvalRequired).toBe(true);
  });

  it("enforces timeouts for in-process handlers", async () => {
    const action = definition({
      manifest: { ...definition().manifest, id: "fixture.timeout", timeoutMs: 10 },
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { summary: "late", output: { value: "late" } };
      }
    });
    const runner = await runnerFor(action);
    const result = await runner.run("fixture.timeout", {});

    expect(result.record.status).toBe("failed");
    expect(result.record.summary).toContain("timed out");
  });

  it("records an attempted command when process startup fails", async () => {
    const command = ["shadow-command-that-does-not-exist"];
    const action = definition({
      manifest: { ...definition().manifest, id: "fixture.spawnfailure" },
      async run(_input, context) {
        await context.execute(command);
        return { summary: "unexpected", output: { value: "unexpected" } };
      }
    });
    const runner = await runnerFor(action);
    const result = await runner.run("fixture.spawnfailure", {});

    expect(result.record.status).toBe("failed");
    expect(result.record.commands).toEqual([command]);
  });

  it("caps subprocess output and stores only the bounded log", async () => {
    const action = definition({
      manifest: {
        ...definition().manifest,
        id: "fixture.outputlimit",
        maxOutputBytes: 100
      },
      async run(_input, context) {
        const processResult = await context.execute([
          process.execPath,
          "-e",
          "process.stdout.write('x'.repeat(5000))"
        ]);
        return {
          summary: processResult.outputLimitExceeded ? "output limit exceeded" : "unexpected",
          output: { value: "bounded" },
          exitCode: processResult.outputLimitExceeded ? 1 : processResult.exitCode,
          stdout: processResult.stdout
        };
      }
    });
    const runner = await runnerFor(action);
    const result = await runner.run("fixture.outputlimit", {});
    const stdout = result.artifacts.find((artifact) => artifact.kind === "action.stdout");

    expect(result.record.status).toBe("failed");
    expect(stdout).toBeDefined();
    expect(await readFile(stdout!.path, "utf8")).toHaveLength(100);
  });

  it("rejects a symlinked working directory outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "shadow-outside-"));
    await symlink(outside, join(workspace, "escape"));
    const runner = new ActionRunner(
      new ActionRegistry().register(definition()),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    await expect(runner.run("fixture.read", {}, { cwd: "escape" })).rejects.toThrow(
      "outside the workspace"
    );
  });

  it("does not expose arbitrary parent secrets to subprocesses", async () => {
    process.env.SHADOW_FIXTURE_SECRET = "must-not-leak";
    const action = definition({
      manifest: { ...definition().manifest, id: "fixture.environment" },
      async run(_input, context) {
        const processResult = await context.execute([
          process.execPath,
          "-e",
          "process.stdout.write(process.env.SHADOW_FIXTURE_SECRET ?? 'missing')"
        ]);
        return {
          summary: "environment checked",
          output: { value: processResult.stdout },
          stdout: processResult.stdout,
          exitCode: processResult.exitCode
        };
      }
    });

    try {
      const result = await (await runnerFor(action)).run<{ value: string }>("fixture.environment", {});
      expect(result.output?.value).toBe("missing");
    } finally {
      delete process.env.SHADOW_FIXTURE_SECRET;
    }
  });

  it("propagates external cancellation into an active subprocess", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-action-cancel-"));
    const controller = new AbortController();
    const action = definition({
      manifest: { ...definition().manifest, id: "fixture.cancel" },
      async run(_input, context) {
        const processResult = await context.execute([
          process.execPath,
          "-e",
          "setInterval(() => undefined, 1000)"
        ]);
        return {
          summary: "process exited",
          output: { value: "done" },
          exitCode: processResult.exitCode
        };
      }
    });
    const runner = new ActionRunner(
      new ActionRegistry().register(action),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts")),
      controller.signal
    );
    const running = runner.run("fixture.cancel", {});
    setTimeout(() => controller.abort(), 20);

    const result = await running;

    expect(result.record.status).toBe("failed");
    expect(result.record.summary).toBe("Action cancelled.");
  });
});
