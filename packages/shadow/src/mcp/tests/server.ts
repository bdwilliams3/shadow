#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "../../artifacts/store.js";
import { TestsService } from "./service.js";
import {
  CancelTestRunResultSchema,
  CoverageResultSchema,
  DiscoverTestsRequestSchema,
  DiscoverTestsResultSchema,
  FailureDetailsRequestSchema,
  FailureDetailsResultSchema,
  TestRunAcceptedSchema,
  TestRunLookupSchema,
  TestRunRequestSchema,
  TestRunSummarySchema
} from "./types.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const executionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function createTestsMcpServer(service: TestsService): McpServer {
  const server = new McpServer({ name: "shadow-tests", version: "0.1.0" });

  server.registerTool(
    "discover_tests",
    {
      description: "Discover Vitest or pytest test identifiers in the configured workspace.",
      inputSchema: DiscoverTestsRequestSchema.shape,
      outputSchema: DiscoverTestsResultSchema.shape,
      annotations: readOnlyAnnotations,
      _meta: { "shadow/sideEffectLevel": "read_only", "shadow/timeoutMs": 60_000 }
    },
    async (input) => result(await service.discoverTests(input))
  );

  server.registerTool(
    "run_tests",
    {
      description: "Start a bounded asynchronous Vitest or pytest run.",
      inputSchema: TestRunRequestSchema.shape,
      outputSchema: TestRunAcceptedSchema.shape,
      annotations: executionAnnotations,
      _meta: { "shadow/sideEffectLevel": "workspace_write", "shadow/approvalRequired": false }
    },
    async (input) => result(service.runTests(input))
  );

  server.registerTool(
    "get_test_status",
    {
      description: "Get the current status of a test run.",
      inputSchema: TestRunLookupSchema.shape,
      outputSchema: TestRunAcceptedSchema.shape,
      annotations: readOnlyAnnotations,
      _meta: { "shadow/sideEffectLevel": "read_only", "shadow/expectedOutput": "small" }
    },
    async ({ run_id }) => result(service.getStatus(run_id))
  );

  server.registerTool(
    "get_test_summary",
    {
      description: "Get compact counts, failures, and artifact references for a test run.",
      inputSchema: TestRunLookupSchema.shape,
      outputSchema: TestRunSummarySchema.shape,
      annotations: readOnlyAnnotations,
      _meta: { "shadow/sideEffectLevel": "read_only", "shadow/expectedOutput": "medium" }
    },
    async ({ run_id }) => result(service.getSummary(run_id))
  );

  server.registerTool(
    "get_failure_details",
    {
      description: "Get normalized failure evidence without returning raw test logs.",
      inputSchema: FailureDetailsRequestSchema.shape,
      outputSchema: FailureDetailsResultSchema.shape,
      annotations: readOnlyAnnotations,
      _meta: { "shadow/sideEffectLevel": "read_only", "shadow/expectedOutput": "medium" }
    },
    async ({ run_id, test_id }) =>
      result({ run_id, failures: service.getFailureDetails(run_id, test_id) })
  );

  server.registerTool(
    "get_coverage_summary",
    {
      description: "Get normalized coverage totals for a completed test run.",
      inputSchema: TestRunLookupSchema.shape,
      outputSchema: CoverageResultSchema.shape,
      annotations: readOnlyAnnotations,
      _meta: { "shadow/sideEffectLevel": "read_only", "shadow/expectedOutput": "small" }
    },
    async ({ run_id }) => result({ run_id, coverage: service.getCoverageSummary(run_id) })
  );

  server.registerTool(
    "cancel_test_run",
    {
      description: "Cancel an active test subprocess.",
      inputSchema: TestRunLookupSchema.shape,
      outputSchema: CancelTestRunResultSchema.shape,
      annotations: executionAnnotations,
      _meta: { "shadow/sideEffectLevel": "workspace_write", "shadow/idempotent": true }
    },
    async ({ run_id }) => result(service.cancelTestRun(run_id))
  );

  return server;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("shadow-tests-mcp")
    .requiredOption("--workspace <path>")
    .requiredOption("--artifacts <path>")
    .parse(process.argv);
  const options = program.opts<{ workspace: string; artifacts: string }>();
  const service = new TestsService(options.workspace, new ArtifactStore(options.artifacts));
  await createTestsMcpServer(service).connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
