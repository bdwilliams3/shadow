import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { parsePytestJunit, parseVitestReport } from "../src/mcp/tests/parsers.js";
import { createTestsMcpServer } from "../src/mcp/tests/server.js";
import { TestsService } from "../src/mcp/tests/service.js";
import { TestRunSummarySchema } from "../src/mcp/tests/types.js";

async function vitestWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-tests-mcp-"));
  const binary = join(workspace, "node_modules/.bin/vitest");
  await mkdir(join(workspace, "node_modules/.bin"), { recursive: true });
  await writeFile(
    binary,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
if (process.argv.includes("list")) {
  process.stdout.write(JSON.stringify([{ name: "works", file: "/fixture/example.test.ts" }]));
  process.exit(0);
}
const output = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ name: "example.test.ts", assertionResults: [{ fullName: "example works", status: "passed" }] }]
}));
process.stdout.write("raw test output");
`,
    { encoding: "utf8", mode: 0o755 }
  );
  await chmod(binary, 0o755);
  return workspace;
}

async function waitForSummary(service: TestsService, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = service.getSummary(runId);
    if (!["queued", "running"].includes(summary.status)) {
      return summary;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Test run did not finish.");
}

describe("Tests MCP", () => {
  it("parses Vitest JSON and pytest JUnit failures into compact evidence", () => {
    const vitest = parseVitestReport(JSON.stringify({
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 1,
      testResults: [{
        name: "example.test.ts",
        assertionResults: [{
          fullName: "example fails",
          status: "failed",
          failureMessages: ["expected 1 to be 2\n at example.test.ts:12:4"]
        }]
      }]
    }));
    const pytest = parsePytestJunit(`<?xml version="1.0"?>
      <testsuites><testsuite tests="2" failures="1" errors="0" skipped="0">
        <testcase classname="tests.test_cli" name="test_ok" />
        <testcase classname="tests.test_cli" name="test_bad">
          <failure message="assert 1 == 2">tests/test_cli.py:8: AssertionError</failure>
        </testcase>
      </testsuite></testsuites>`);

    expect(vitest.counts).toEqual({ passed: 2, failed: 1, skipped: 1 });
    expect(vitest.failures[0]?.relevant_frames).toEqual(["example.test.ts:12:4"]);
    expect(pytest.counts).toEqual({ passed: 1, failed: 1, skipped: 0 });
    expect(pytest.failures[0]?.test_id).toBe("tests.test_cli::test_bad");
  });

  it("discovers and runs Vitest while storing raw logs as artifacts", async () => {
    const workspace = await vitestWorkspace();
    const artifacts = new ArtifactStore(join(workspace, ".shadow/artifacts"));
    const service = new TestsService(workspace, artifacts);

    const discovery = await service.discoverTests({ workspace_id: workspace, framework: "auto" });
    const accepted = service.runTests({
      workspace_id: workspace,
      framework: "vitest",
      timeout_seconds: 5,
      max_retries: 0
    });
    const summary = await waitForSummary(service, accepted.run_id);

    expect(discovery.status).toBe("completed");
    expect(discovery.tests[0]).toContain("example.test.ts > works");
    expect(summary.status).toBe("passed");
    expect(summary.counts.passed).toBe(1);
    expect(summary.artifacts).toHaveLength(1);
    expect(await readFile(summary.artifacts[0]!.path, "utf8")).toBe("raw test output");
  });

  it("publishes all seven tools over MCP with structured responses", async () => {
    const workspace = await vitestWorkspace();
    const service = new TestsService(
      workspace,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );
    const server = createTestsMcpServer(service);
    const client = new Client({ name: "shadow-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "cancel_test_run",
        "discover_tests",
        "get_coverage_summary",
        "get_failure_details",
        "get_test_status",
        "get_test_summary",
        "run_tests"
      ]);
      const accepted = await client.callTool({
        name: "run_tests",
        arguments: {
          workspace_id: workspace,
          framework: "vitest",
          timeout_seconds: 5,
          max_retries: 0
        }
      });
      const runId = (accepted.structuredContent as { run_id: string }).run_id;
      let summary = TestRunSummarySchema.parse({
        run_id: runId,
        status: "queued",
        counts: {},
        duration_ms: 0,
        attempts: 0
      });
      while (["queued", "running"].includes(summary.status)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        const response = await client.callTool({
          name: "get_test_summary",
          arguments: { run_id: runId }
        });
        summary = TestRunSummarySchema.parse(response.structuredContent);
      }
      expect(summary.status).toBe("passed");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
