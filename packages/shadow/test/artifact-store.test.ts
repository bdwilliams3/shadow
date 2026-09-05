import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";

describe("ArtifactStore", () => {
  it("reads only hash-verified content inside the configured store", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shadow-artifacts-"));
    const store = new ArtifactStore(join(workspace, "artifacts"));
    const reference = await store.writeText("design.result", "design.json", "trusted");

    expect(await store.readText(reference)).toBe("trusted");
    await writeFile(reference.path, "tampered", "utf8");
    await expect(store.readText(reference)).rejects.toThrow("integrity");

    const outsidePath = join(workspace, "outside.txt");
    await writeFile(outsidePath, "outside", "utf8");
    await expect(store.readText({
      id: "outside",
      kind: "action.result",
      path: outsidePath,
      sha256: createHash("sha256").update("outside").digest("hex"),
      bytes: 7
    })).rejects.toThrow("outside");
  });
});
