import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { RepositoryIndex } from "../src/context/repository-index.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { RepositoryInventory } from "../src/tools/actions/repository.js";
import type { TestSelection } from "../src/tools/actions/tests.js";
import { createDefaultActionRegistry } from "../src/tools/default-registry.js";
import { ActionRunner } from "../src/tools/runner.js";

const execFileAsync = promisify(execFile);

async function indexedWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "shadow-index-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await Promise.all([
    mkdir(join(workspace, "src")),
    mkdir(join(workspace, "test")),
    mkdir(join(workspace, "python"))
  ]);
  await writeFile(
    join(workspace, "src/payment.ts"),
    'import { Money } from "./money.js";\nexport class PaymentProcessor { charge(value: Money) { return value; } }\n',
    "utf8"
  );
  await writeFile(join(workspace, "src/money.ts"), "export interface Money { cents: number }\n", "utf8");
  await writeFile(
    join(workspace, "test/payment.test.ts"),
    'import { PaymentProcessor } from "../src/payment.js";\nexport const subject = PaymentProcessor;\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "python/worker.py"),
    "import asyncio\n\nclass QueueWorker:\n    async def process_jobs(self):\n        return asyncio.sleep(0)\n",
    "utf8"
  );
  await writeFile(join(workspace, "package.json"), '{"name":"index-fixture"}\n', "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  return workspace;
}

function runnerFor(workspace: string): ActionRunner {
  return new ActionRunner(
    createDefaultActionRegistry(),
    workspace,
    defaultConfig,
    new ArtifactStore(join(workspace, ".shadow/artifacts"))
  );
}

describe("repository index", () => {
  it("indexes symbols and imports, then invalidates changed and removed files by hash", async () => {
    const workspace = await indexedWorkspace();
    const runner = runnerFor(workspace);

    const first = await runner.run<RepositoryInventory>("repository.inspect", {});
    const second = await runner.run<RepositoryInventory>("repository.inspect", {});
    const index = new RepositoryIndex(join(workspace, ".shadow/shadow.db"), workspace);
    const payment = index.getFile("src/payment.ts");
    const python = index.getFile("python/worker.py");
    const symbolMatches = index.search("QueueWorker process jobs");
    index.close();

    expect(first.output?.updatedFiles).toBe(5);
    expect(first.record.commands.some((command) => command[0] === "python3")).toBe(true);
    expect(second.output?.updatedFiles).toBe(0);
    expect(second.output?.unchangedFiles).toBe(5);
    expect(payment?.symbols).toContain("PaymentProcessor");
    expect(payment?.imports).toContain("./money.js");
    expect(python?.symbols).toEqual(expect.arrayContaining(["QueueWorker", "process_jobs"]));
    expect(symbolMatches[0]?.path).toBe("python/worker.py");

    await writeFile(join(workspace, "src/payment.ts"), "export class CheckoutService {}\n", "utf8");
    await rm(join(workspace, "python/worker.py"));
    const third = await runner.run<RepositoryInventory>("repository.inspect", {});
    const refreshed = new RepositoryIndex(join(workspace, ".shadow/shadow.db"), workspace);
    expect(third.output?.updatedFiles).toBe(1);
    expect(third.output?.removedFiles).toBe(1);
    expect(refreshed.getFile("python/worker.py")).toBeUndefined();
    expect(refreshed.search("CheckoutService")[0]?.path).toBe("src/payment.ts");
    refreshed.close();
  });

  it("maps changed source files to tests using indexed import relationships", async () => {
    const workspace = await indexedWorkspace();
    const selection = await runnerFor(workspace).run<TestSelection>("tests.select", {
      changedFiles: ["src/payment.ts"]
    });

    expect(selection.output).toMatchObject({
      selectors: ["test/payment.test.ts"],
      strategy: "targeted"
    });
  });

  it("keeps configured exclusion globs out of metadata and FTS content", async () => {
    const workspace = await indexedWorkspace();
    await mkdir(join(workspace, "generated"));
    await writeFile(
      join(workspace, "generated/private.ts"),
      "export const NeverIndexThisSecret = true;\n",
      "utf8"
    );
    await execFileAsync("git", ["add", "generated/private.ts"], { cwd: workspace });
    const result = await runnerFor(workspace).run<RepositoryInventory>("repository.inspect", {
      exclusions: ["generated/**"]
    });
    const index = new RepositoryIndex(join(workspace, ".shadow/shadow.db"), workspace);

    expect(result.output?.fileCount).toBe(5);
    expect(index.getFile("generated/private.ts")).toBeUndefined();
    expect(index.search("NeverIndexThisSecret")).toEqual([]);
    index.close();
  });
});
