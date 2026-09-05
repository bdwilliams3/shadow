import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { discoverRepositoryFiles } from "../../context/repository-index.js";
import type { ActionDefinition } from "../types.js";

const SecurityScanInputSchema = z.object({
  exclusions: z.array(z.string().min(1)).default([]),
  maxFiles: z.number().int().positive().max(100_000).default(20_000),
  maxFileBytes: z.number().int().positive().max(10_000_000).default(1_000_000)
});

const SecretFindingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  rule: z.string().min(1),
  severity: z.enum(["high", "warning"])
});

export const SecretScanResultSchema = z.object({
  status: z.enum(["clear", "findings"]),
  scannedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  findings: z.array(SecretFindingSchema),
  highConfidenceFindings: z.number().int().nonnegative()
});
export type SecretScanResult = z.infer<typeof SecretScanResultSchema>;

const DependencyFindingSchema = z.object({
  path: z.string().min(1),
  package: z.string().min(1).optional(),
  rule: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1)
});

export const DependencyScanResultSchema = z.object({
  status: z.enum(["passed", "warnings", "failed", "not_configured"]),
  manifests: z.number().int().nonnegative(),
  dependencies: z.number().int().nonnegative(),
  advisoryDatabase: z.literal("not_checked"),
  findings: z.array(DependencyFindingSchema)
});
export type DependencyScanResult = z.infer<typeof DependencyScanResultSchema>;

interface SecretRule {
  id: string;
  severity: "high" | "warning";
  pattern: RegExp;
  valueGroup?: number;
}

const secretRules: SecretRule[] = [
  {
    id: "private_key",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g
  },
  { id: "aws_access_key", severity: "high", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github_token", severity: "high", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: "openai_key", severity: "high", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "slack_token", severity: "high", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  {
    id: "credential_assignment",
    severity: "warning",
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']([^"']{8,})["']/gi,
    valueGroup: 1
  }
];

const placeholderPattern = /^(?:change[-_ ]?me|example|fake|placeholder|redacted|test|your[-_ ])/i;
const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const PackageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional()
});

export const secretScanAction: ActionDefinition<
  z.infer<typeof SecurityScanInputSchema>,
  SecretScanResult
> = {
  manifest: {
    id: "security.secrets",
    version: 1,
    description: "Scan repository text for high-confidence credential patterns without returning values.",
    handler: "@shadow/actions/security/secrets",
    inputSchema: "security_scan_input_v1",
    outputSchema: "secret_scan_result_v1",
    risk: "read_only",
    timeoutMs: 120_000,
    maxOutputBytes: 1_000_000,
    network: false,
    writesWorkspace: false,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: true
  },
  input: SecurityScanInputSchema,
  output: SecretScanResultSchema,
  async run(input, context) {
    const discovery = await discoverRepositoryFiles(
      context.workspaceRoot,
      input.maxFiles,
      context.execute,
      input.exclusions
    );
    const findings: z.infer<typeof SecretFindingSchema>[] = [];
    let scannedFiles = 0;
    let skippedFiles = 0;
    for (const path of discovery.paths) {
      const content = await readBoundedText(context.workspaceRoot, path, input.maxFileBytes);
      if (content === undefined) {
        skippedFiles += 1;
        continue;
      }
      scannedFiles += 1;
      for (const rule of secretRules) {
        rule.pattern.lastIndex = 0;
        for (const match of content.matchAll(rule.pattern)) {
          const value = rule.valueGroup === undefined ? undefined : match[rule.valueGroup];
          if (value && placeholderPattern.test(value)) {
            continue;
          }
          findings.push({
            path,
            line: lineNumberAt(content, match.index),
            rule: rule.id,
            severity: rule.severity
          });
          if (findings.length >= 500) {
            break;
          }
        }
        if (findings.length >= 500) break;
      }
      if (findings.length >= 500) break;
    }
    const highConfidenceFindings = findings.filter((finding) => finding.severity === "high").length;
    const output: SecretScanResult = {
      status: findings.length > 0 ? "findings" : "clear",
      scannedFiles,
      skippedFiles,
      truncated: discovery.paths.length >= input.maxFiles || findings.length >= 500,
      findings,
      highConfidenceFindings
    };
    return {
      summary: findings.length === 0
        ? `Secret scan inspected ${scannedFiles} files with no findings.`
        : `Secret scan found ${highConfidenceFindings} high-confidence and ${findings.length - highConfidenceFindings} warning-level findings.`,
      output,
      commands: discovery.commands,
      exitCode: highConfidenceFindings > 0 ? 1 : 0
    };
  }
};

export const dependencyScanAction: ActionDefinition<
  z.infer<typeof SecurityScanInputSchema>,
  DependencyScanResult
> = {
  manifest: {
    id: "security.dependencies",
    version: 1,
    description: "Validate package dependency declarations and lockfile coverage without network access.",
    handler: "@shadow/actions/security/dependencies",
    inputSchema: "security_scan_input_v1",
    outputSchema: "dependency_scan_result_v1",
    risk: "read_only",
    timeoutMs: 120_000,
    maxOutputBytes: 1_000_000,
    network: false,
    writesWorkspace: false,
    writesOutsideWorkspace: false,
    deploys: false,
    touchesSecrets: false,
    idempotent: true
  },
  input: SecurityScanInputSchema,
  output: DependencyScanResultSchema,
  async run(input, context) {
    const discovery = await discoverRepositoryFiles(
      context.workspaceRoot,
      input.maxFiles,
      context.execute,
      input.exclusions
    );
    const manifests = discovery.paths.filter((path) => basename(path) === "package.json");
    const findings: z.infer<typeof DependencyFindingSchema>[] = [];
    let dependencies = 0;
    for (const path of manifests) {
      const content = await readBoundedText(context.workspaceRoot, path, input.maxFileBytes);
      if (content === undefined) {
        findings.push({
          path,
          rule: "unreadable_manifest",
          severity: "error",
          message: "Manifest is not a bounded text file."
        });
        continue;
      }
      let manifest: z.infer<typeof PackageManifestSchema>;
      try {
        manifest = PackageManifestSchema.parse(JSON.parse(content));
      } catch {
        findings.push({
          path,
          rule: "invalid_manifest",
          severity: "error",
          message: "package.json is not valid structured dependency data."
        });
        continue;
      }
      const entries = dependencyGroups.flatMap((group) => Object.entries(manifest[group] ?? {}));
      dependencies += entries.length;
      for (const [name, specification] of entries) {
        const finding = dependencySpecificationFinding(path, name, specification);
        if (finding) findings.push(finding);
      }
      if (entries.length > 0 && !hasPackageLock(context.workspaceRoot, dirname(path))) {
        findings.push({
          path,
          rule: "missing_lockfile",
          severity: "warning",
          message: "No npm, pnpm, Yarn, or Bun lockfile covers this manifest."
        });
      }
    }
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const status: DependencyScanResult["status"] = manifests.length === 0
      ? "not_configured"
      : errors > 0
        ? "failed"
        : findings.length > 0
          ? "warnings"
          : "passed";
    return {
      summary: manifests.length === 0
        ? "No package.json dependency manifests were found."
        : `Dependency scan inspected ${dependencies} declarations in ${manifests.length} manifests; vulnerability advisories were not queried.`,
      output: {
        status,
        manifests: manifests.length,
        dependencies,
        advisoryDatabase: "not_checked",
        findings
      },
      commands: discovery.commands,
      exitCode: errors > 0 ? 1 : 0
    };
  }
};

async function readBoundedText(
  workspaceRoot: string,
  path: string,
  maxFileBytes: number
): Promise<string | undefined> {
  try {
    const absolute = resolve(workspaceRoot, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxFileBytes) {
      return undefined;
    }
    const canonical = await realpath(absolute);
    const relativePath = relative(workspaceRoot, canonical);
    if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      return undefined;
    }
    const content = await readFile(canonical);
    return content.includes(0) ? undefined : content.toString("utf8");
  } catch {
    return undefined;
  }
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function dependencySpecificationFinding(
  path: string,
  name: string,
  specification: string
): z.infer<typeof DependencyFindingSchema> | undefined {
  if (specification === "*" || specification.toLowerCase() === "latest") {
    return {
      path,
      package: name,
      rule: "unbounded_version",
      severity: "warning",
      message: "Dependency uses an unbounded version specification."
    };
  }
  if (/^(?:git(?:\+|:)|https?:|github:)/i.test(specification)) {
    return {
      path,
      package: name,
      rule: "remote_source",
      severity: "warning",
      message: "Dependency resolves directly from a remote source instead of a registry version."
    };
  }
  return undefined;
}

function hasPackageLock(workspaceRoot: string, manifestDirectory: string): boolean {
  const candidates = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];
  let directory = resolve(workspaceRoot, manifestDirectory);
  while (true) {
    if (candidates.some((name) => existsSync(resolve(directory, name)))) return true;
    if (directory === workspaceRoot) return false;
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(workspaceRoot)) return false;
    directory = parent;
  }
}
