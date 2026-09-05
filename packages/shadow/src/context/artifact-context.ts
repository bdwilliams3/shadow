import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactReference } from "../orchestration/types.js";

export interface ArtifactContextEntry {
  id: string;
  kind: string;
  content: string;
}

export async function loadArtifactContext(
  store: ArtifactStore,
  references: ArtifactReference[],
  allowedKinds: ReadonlySet<string>,
  maxTotalBytes = 40_000
): Promise<ArtifactContextEntry[]> {
  const entries: ArtifactContextEntry[] = [];
  let remaining = maxTotalBytes;
  for (const reference of references) {
    if (!allowedKinds.has(reference.kind) || remaining <= 0) continue;
    try {
      const content = await store.readText(reference);
      const bytes = Buffer.from(content);
      const selected = bytes.subarray(0, remaining).toString("utf8");
      entries.push({ id: reference.id, kind: reference.kind, content: selected });
      remaining -= Buffer.byteLength(selected);
    } catch {
      // Invalid or oversized artifacts remain auditable references but are not added to model context.
    }
  }
  return entries;
}
