import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { ArtifactReference } from "../orchestration/types.js";

export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async writeText(kind: string, name: string, content: string): Promise<ArtifactReference> {
    const bytes = Buffer.byteLength(content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const artifactDir = resolve(this.rootDir, sha256.slice(0, 2));
    await mkdir(artifactDir, { recursive: true });
    const safeName = basename(name).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
    const path = resolve(artifactDir, `${sha256}-${safeName}`);
    await writeFile(path, content, "utf8");

    return {
      id: randomUUID(),
      kind,
      path,
      sha256,
      bytes
    };
  }

  async readText(reference: ArtifactReference, maxBytes = 500_000): Promise<string> {
    if (reference.bytes > maxBytes) {
      throw new Error(`Artifact ${reference.id} exceeds the ${maxBytes} byte read limit.`);
    }
    const [root, path] = await Promise.all([realpath(this.rootDir), realpath(reference.path)]);
    const candidate = relative(root, path);
    if (candidate === ".." || candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Artifact ${reference.id} is outside the configured artifact store.`);
    }
    const content = await readFile(path);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== reference.sha256 || content.byteLength !== reference.bytes) {
      throw new Error(`Artifact ${reference.id} failed its integrity check.`);
    }
    return content.toString("utf8");
  }
}
