import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { BenchmarkFixtureSchema } from "../src/benchmarks/fixture.js";

const fixturePaths = [
  "fixtures/benchmarks/python-cli/fixture.yaml",
  "fixtures/benchmarks/typescript-app/fixture.yaml",
  "fixtures/benchmarks/mixed-service/fixture.yaml"
];
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("benchmark fixtures", () => {
  it.each(fixturePaths)("validates %s", async (path) => {
    const fixture = BenchmarkFixtureSchema.parse(
      YAML.parse(await readFile(resolve(repositoryRoot, path), "utf8"))
    );

    expect(fixture.repositoryRevision).toBe(1);
    expect(fixture.tasks.length).toBeGreaterThan(0);
  });
});
