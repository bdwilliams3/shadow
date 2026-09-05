import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { TestCountsSchema, TestFailure } from "./types.js";

type TestCounts = z.infer<typeof TestCountsSchema>;

const VitestAssertionSchema = z.object({
  ancestorTitles: z.array(z.string()).optional(),
  title: z.string().optional(),
  fullName: z.string().optional(),
  status: z.string().optional(),
  failureMessages: z.array(z.string()).optional()
});

const VitestReportSchema = z.object({
  numPassedTests: z.number().int().nonnegative().optional(),
  numFailedTests: z.number().int().nonnegative().optional(),
  numPendingTests: z.number().int().nonnegative().optional(),
  numTodoTests: z.number().int().nonnegative().optional(),
  testResults: z.array(
    z.object({
      name: z.string().optional(),
      message: z.string().optional(),
      assertionResults: z.array(VitestAssertionSchema).optional()
    })
  ).optional()
});

function relevantFrames(message: string): string[] {
  return [...message.matchAll(/(?:^|\s)([^\s()]+:\d+(?::\d+)?)/gm)]
    .map((match) => match[1])
    .filter((frame): frame is string => frame !== undefined)
    .slice(0, 5);
}

export function parseVitestReport(source: string): { counts: TestCounts; failures: TestFailure[] } {
  const report = VitestReportSchema.parse(JSON.parse(source));
  const failures: TestFailure[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== "failed") {
        continue;
      }
      const message = assertion.failureMessages?.join("\n") || file.message || "Test failed.";
      failures.push({
        test_id: assertion.fullName ?? assertion.title ?? file.name ?? "unknown test",
        category: /timed?\s*out/i.test(message) ? "timeout" : "assertion",
        message: message.slice(0, 2_000),
        relevant_frames: relevantFrames(message)
      });
    }
  }
  return {
    counts: {
      passed: report.numPassedTests ?? 0,
      failed: report.numFailedTests ?? failures.length,
      skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
    },
    failures
  };
}

type XmlNode = Record<string, unknown>;

function nodes(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is XmlNode => typeof entry === "object" && entry !== null);
  }
  return typeof value === "object" && value !== null ? [value as XmlNode] : [];
}

function numberAttribute(node: XmlNode, name: string): number {
  const value = node[`@_${name}`];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function failureText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return "Test failed.";
  }
  const node = value as XmlNode;
  return [node["@_message"], node["#text"]]
    .filter((part): part is string => typeof part === "string")
    .join("\n") || "Test failed.";
}

export function parsePytestJunit(source: string): { counts: TestCounts; failures: TestFailure[] } {
  const parsed = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true }).parse(source) as XmlNode;
  const suites = nodes(parsed.testsuites ? (parsed.testsuites as XmlNode).testsuite : parsed.testsuite);
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const failures: TestFailure[] = [];

  for (const suite of suites) {
    const total = numberAttribute(suite, "tests");
    const failed = numberAttribute(suite, "failures") + numberAttribute(suite, "errors");
    const skipped = numberAttribute(suite, "skipped");
    counts.failed += failed;
    counts.skipped += skipped;
    counts.passed += Math.max(0, total - failed - skipped);
    for (const testcase of nodes(suite.testcase)) {
      const failure = testcase.failure ?? testcase.error;
      if (failure === undefined) {
        continue;
      }
      const message = failureText(failure);
      const className = typeof testcase["@_classname"] === "string" ? testcase["@_classname"] : "";
      const name = typeof testcase["@_name"] === "string" ? testcase["@_name"] : "unknown test";
      failures.push({
        test_id: className ? `${className}::${name}` : name,
        category: testcase.error === undefined ? "assertion" : "error",
        message: message.slice(0, 2_000),
        relevant_frames: relevantFrames(message)
      });
    }
  }

  return { counts, failures };
}
