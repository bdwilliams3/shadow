import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { defaultConfig } from "../src/config/defaults.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";
import type { QualityResult } from "../src/tools/actions/quality.js";
import type { RepositoryInventory } from "../src/tools/actions/repository.js";
import type { ContextVerification, SelectedContext } from "../src/tools/actions/context.js";
import type { GitStatusSummary } from "../src/tools/actions/git.js";

const execFileAsync = promisify(execFile);

describe("built-in actions", () => {
  it("publishes versioned machine-readable manifests", () => {
    expect(createDefaultActionRegistry().list().map((manifest) => manifest.id)).toEqual([
      "context.select",
      "context.verify",
      "deploy.execute",
      "deploy.rollback",
      "git.status",
      "patch.apply",
      "patch.check",
      "quality.test",
      "quality.typecheck",
      "repository.inspect",
      "security.dependencies",
      "security.secrets",
      "tests.select"
    ]);
  });

  it("inspects a repository without loading file contents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-inspect-"));
    await writeFile(join(workspace, "package.json"), '{"name":"fixture"}\n', "utf8");
    await writeFile(join(workspace, "index.ts"), "export const value = 1;\n", "utf8");
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<RepositoryInventory>("repository.inspect", {});

    expect(result.record.status).toBe("completed");
    expect(result.output?.languages.TypeScript).toBe(1);
    expect(result.output?.manifests).toContain("package.json");
    expect(result.output?.indexedFileCount).toBe(2);
  });

  it("runs a configured test script and returns compact status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-quality-"));
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "console.log(123)"' } }),
      "utf8"
    );
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<QualityResult>("quality.test", {});

    expect(result.record.status).toBe("completed");
    expect(result.output?.status).toBe("passed");
    expect(result.record.commands[0]?.slice(0, 3)).toEqual(["npm", "run", "test"]);
    expect(result.artifacts.some((artifact) => artifact.kind === "action.stdout")).toBe(true);
  });

  it("redacts likely credentials before returning model context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-context-"));
    await writeFile(join(workspace, "credentials.ts"), 'export const apiKey = "super-secret-value";\n', "utf8");
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<SelectedContext>("context.select", {
      request: "update credentials.ts"
    });

    expect(result.output?.redactionCount).toBe(1);
    expect(result.output?.files[0]?.content).toContain("[REDACTED]");
    expect(result.output?.files[0]?.content).not.toContain("super-secret-value");
  });

  it("uses indexed symbols to rank relevant context ahead of alphabetical files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-context-fts-"));
    await Promise.all([
      ...Array.from({ length: 12 }, (_value, index) =>
        writeFile(join(workspace, `a${String(index).padStart(2, "0")}.ts`), "export const noise = true;\n", "utf8")
      ),
      writeFile(
        join(workspace, "z-checkout.ts"),
        "export class CheckoutCoordinator { complete() {} }\n",
        "utf8"
      )
    ]);
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<SelectedContext>("context.select", {
      request: "update CheckoutCoordinator",
      maxFiles: 1
    });

    expect(result.output?.files.map((file) => file.path)).toEqual(["z-checkout.ts"]);
  });

  it("selects config files for configuration requests instead of only connector bodies", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-context-config-"));
    await mkdir(join(workspace, "core/connectors"), { recursive: true });
    await writeFile(
      join(workspace, "core/config.py"),
      "from dataclasses import dataclass\n\n@dataclass(frozen=True)\nclass ProviderCreds:\n    extra: dict[str, str]\n",
      "utf8"
    );
    await writeFile(
      join(workspace, "core/connectors/cloudflare.py"),
      "from ..config import ProviderCreds\n\nclass CloudflareConnector:\n    pass\n",
      "utf8"
    );
    await writeFile(
      join(workspace, "skills-cloudflare.md"),
      "Cloudflare connector request timeout documentation.\n",
      "utf8"
    );
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<SelectedContext>("context.select", {
      request: "Give connector configuration an explicit request timeout with a default.",
      maxFiles: 2
    });

    expect(result.output?.files.map((file) => file.path)).toContain("core/config.py");
  });

  it("skips a lower-ranked file that only fits as a fragment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-context-fragment-"));
    await writeFile(join(workspace, "target-one.txt"), "target\n".repeat(100), "utf8");
    await writeFile(join(workspace, "target-two.txt"), "target\n".repeat(2_000), "utf8");
    await writeFile(join(workspace, "target-three.txt"), "target\n", "utf8");
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<SelectedContext>("context.select", {
      request: "target",
      candidatePaths: ["target-one.txt", "target-three.txt"],
      maxFiles: 3,
      maxBytes: 1_000
    });

    expect(result.output?.files.map((file) => file.path)).toEqual([
      "target-one.txt",
      "target-three.txt"
    ]);
    expect(result.output?.files.every((file) => !file.truncated)).toBe(true);
  });

  it("detects selected files that change before patch application", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-context-verify-"));
    const path = join(workspace, "target.ts");
    await writeFile(path, "export const value = 1;\n", "utf8");
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );
    const selected = await runner.run<SelectedContext>("context.select", { request: "change target.ts" });
    await writeFile(path, "export const value = 2;\n", "utf8");

    const verified = await runner.run<ContextVerification>("context.verify", {
      files: selected.output?.files.map((file) => ({ path: file.path, sha256: file.sha256 }))
    });

    expect(verified.record.status).toBe("failed");
    expect(verified.output?.valid).toBe(false);
    expect(verified.output?.mismatches[0]?.path).toBe("target.ts");
  });

  it("excludes Shadow runtime files from Git change summaries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-git-status-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await mkdir(join(workspace, ".shadow/artifacts/aa"), { recursive: true });
    await writeFile(join(workspace, "user-file.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(workspace, ".shadow/shadow.db"), "internal", "utf8");
    await writeFile(join(workspace, ".shadow/artifacts/aa/log"), "internal", "utf8");
    const runner = new ActionRunner(
      createDefaultActionRegistry(),
      workspace,
      defaultConfig,
      new ArtifactStore(join(workspace, ".shadow/artifacts"))
    );

    const result = await runner.run<GitStatusSummary>("git.status", {});

    expect(result.output?.changedFiles).toEqual(["user-file.ts"]);
  });
});
