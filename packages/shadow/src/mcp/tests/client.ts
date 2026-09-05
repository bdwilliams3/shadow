import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ShadowConfig } from "../../config/schema.js";
import {
  TestRunAcceptedSchema,
  TestRunSummarySchema,
  type TestRunRequest,
  type TestRunSummary
} from "./types.js";

const terminalStatuses = new Set(["passed", "failed", "cancelled", "timed_out", "not_configured"]);

export interface TestsExecutor {
  runTests(request: TestRunRequest, signal?: AbortSignal): Promise<TestRunSummary>;
}

export interface TestsMcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  startupTimeoutMs: number;
  pollIntervalMs: number;
}

export class TestsMcpClient implements TestsExecutor {
  constructor(private readonly options: TestsMcpClientOptions) {}

  async inspect(): Promise<{ serverName: string; serverVersion: string; tools: string[] }> {
    const transport = this.createTransport();
    const client = new Client({ name: "shadow", version: "0.1.0" });
    try {
      await bounded(client.connect(transport), this.options.startupTimeoutMs);
      const tools = await client.listTools(undefined, { timeout: this.options.startupTimeoutMs });
      const server = client.getServerVersion();
      return {
        serverName: server?.name ?? "unknown",
        serverVersion: server?.version ?? "unknown",
        tools: tools.tools.map((tool) => tool.name)
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async runTests(request: TestRunRequest, signal?: AbortSignal): Promise<TestRunSummary> {
    const transport = this.createTransport();
    const client = new Client({ name: "shadow", version: "0.1.0" });
    let runId: string | undefined;
    try {
      await bounded(client.connect(transport), this.options.startupTimeoutMs, signal);
      const acceptedResult = await client.callTool(
        { name: "run_tests", arguments: request },
        undefined,
        { timeout: this.options.startupTimeoutMs, ...(signal ? { signal } : {}) }
      );
      const accepted = TestRunAcceptedSchema.parse(acceptedResult.structuredContent);
      runId = accepted.run_id;

      while (true) {
        const summaryResult = await client.callTool(
          { name: "get_test_summary", arguments: { run_id: runId } },
          undefined,
          { timeout: this.options.startupTimeoutMs, ...(signal ? { signal } : {}) }
        );
        const summary = TestRunSummarySchema.parse(summaryResult.structuredContent);
        if (terminalStatuses.has(summary.status)) {
          return summary;
        }
        await delay(this.options.pollIntervalMs, signal);
      }
    } finally {
      if (signal?.aborted && runId) {
        await client.callTool(
          { name: "cancel_test_run", arguments: { run_id: runId } },
          undefined,
          { timeout: 1_000 }
        ).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }

  private createTransport(): StdioClientTransport {
    return new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      stderr: "pipe"
    });
  }
}

export function createConfiguredTestsExecutor(
  config: ShadowConfig,
  workspaceRoot: string
): TestsMcpClient | undefined {
  if (!config.mcp.tests.enabled) {
    return undefined;
  }
  const configured = config.mcp.tests.command;
  const bundledServer = fileURLToPath(new URL("./server.js", import.meta.url));
  if (!configured && !existsSync(bundledServer)) {
    return undefined;
  }
  const command = configured?.[0] ?? process.execPath;
  if (!command) {
    return undefined;
  }
  const args = [
    ...(configured?.slice(1) ?? [bundledServer]),
    "--workspace",
    workspaceRoot,
    "--artifacts",
    resolve(workspaceRoot, config.persistence.artifactsDir)
  ];
  return new TestsMcpClient({
    command,
    args,
    cwd: workspaceRoot,
    startupTimeoutMs: config.mcp.tests.startupTimeoutMs,
    pollIntervalMs: config.mcp.tests.pollIntervalMs
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(new DOMException("cancelled", "AbortError"));
      return;
    }
    const abort = (): void => {
      clearTimeout(timeout);
      rejectDelay(new DOMException("cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function bounded<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolveOperation, rejectOperation) => {
    if (signal?.aborted) {
      rejectOperation(new DOMException("cancelled", "AbortError"));
      return;
    }
    const abort = (): void => {
      clearTimeout(timeout);
      rejectOperation(new DOMException("cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      rejectOperation(new Error(`Tests MCP startup timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolveOperation(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        rejectOperation(error);
      }
    );
  });
}
