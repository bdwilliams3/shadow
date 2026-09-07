import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * OpenAI's `apply_patch` envelope, which frontier models emit in place of a unified
 * diff often enough to lose benchmark tasks on format alone. It carries no line
 * numbers: hunks are located by their own context, optionally narrowed by an `@@`
 * marker naming an enclosing scope. Translating it here means Git — and therefore
 * every existing guard on deletion, symlinks, scope, and binary content — still sees
 * an ordinary unified diff and remains the sole authority on what a patch does.
 */

const beginMarker = "*** Begin Patch";
const endMarker = "*** End Patch";
const noNewlineMarker = "\\ No newline at end of file";
const fileHeaderPattern = /^\*\*\* (Update File|Add File|Delete File|Move to|End of File):?[ \t]*(.*)$/;

interface HunkLine {
  tag: " " | "-" | "+";
  text: string;
}

interface Hunk {
  /** Text after `@@`, naming an enclosing scope. Empty when the model wrote a bare `@@`. */
  marker: string;
  lines: HunkLine[];
}

type Operation =
  | { kind: "update"; path: string; hunks: Hunk[] }
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string };

export interface EnvelopeTranslation {
  /** A unified diff equivalent to the envelope, ready for `git apply`. */
  patch: string;
  paths: string[];
}

export class ApplyPatchEnvelopeError extends Error {}

/**
 * True when the text is an `apply_patch` envelope rather than a unified diff. Checked
 * before parsing so an ordinary diff never takes this path.
 */
export function looksLikeApplyPatchEnvelope(patch: string): boolean {
  return /^\s*\*\*\* Begin Patch[ \t]*$/m.test(patch);
}

export function looksLikeApplyPatchFragment(patch: string): boolean {
  return !looksLikeApplyPatchEnvelope(patch) &&
    /^\s*\*\*\* (?:Update File|Add File|Delete File|Move to):?[ \t]+\S/m.test(patch);
}

function assertWorkspacePath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new ApplyPatchEnvelopeError(`Envelope names a path outside the workspace: ${path}`);
  }
}

function parseEnvelope(patch: string): Operation[] {
  const all = patch.split("\n");
  const firstHeader = all.findIndex((line) => fileHeaderPattern.test(line.trim()));
  let begin = all.findIndex((line) => line.trim() === beginMarker);
  if (begin === -1) {
    if (firstHeader === -1) {
      throw new ApplyPatchEnvelopeError("Envelope has no *** Begin Patch line.");
    }
    begin = firstHeader - 1;
  }
  let end = all.findIndex((line, index) => index > begin && line.trim() === endMarker);
  if (end === -1) {
    if (firstHeader === -1) {
      throw new ApplyPatchEnvelopeError("Envelope has no *** End Patch line.");
    }
    end = all.length;
  }

  const operations: Operation[] = [];
  let current: Operation | undefined;
  let hunk: Hunk | undefined;

  const closeHunk = (): void => {
    if (current?.kind === "update" && hunk) {
      if (hunk.lines.length === 0) {
        throw new ApplyPatchEnvelopeError(`Empty hunk for ${current.path}.`);
      }
      current.hunks.push(hunk);
    }
    hunk = undefined;
  };

  for (let index = begin + 1; index < end; index += 1) {
    const line = all[index] ?? "";
    const header = fileHeaderPattern.exec(line.trim());
    if (header) {
      const [, keyword, rest] = header;
      const path = (rest ?? "").trim();
      if (keyword === "End of File") {
        continue;
      }
      if (keyword === "Move to") {
        // A rename needs a `rename from/to` diff the develop scope does not permit;
        // saying so beats emitting a delete-plus-add that the guards would reject
        // with a misleading message.
        throw new ApplyPatchEnvelopeError(
          "Envelope renames a file. Renames require a separate approved action."
        );
      }
      closeHunk();
      if (current) {
        operations.push(current);
      }
      assertWorkspacePath(path);
      current =
        keyword === "Update File"
          ? { kind: "update", path, hunks: [] }
          : keyword === "Add File"
            ? { kind: "add", path, lines: [] }
            : { kind: "delete", path };
      continue;
    }

    if (!current) {
      if (line.trim().length === 0) {
        continue;
      }
      throw new ApplyPatchEnvelopeError(`Envelope content precedes any file header: ${line.trim()}`);
    }

    if (current.kind === "delete") {
      if (line.trim().length > 0) {
        throw new ApplyPatchEnvelopeError(`Delete File for ${current.path} carries content.`);
      }
      continue;
    }

    if (current.kind === "add") {
      if (line.startsWith("+")) {
        current.lines.push(line.slice(1));
      } else if (line.trim().length === 0) {
        current.lines.push("");
      } else {
        throw new ApplyPatchEnvelopeError(
          `Add File for ${current.path} has a line that does not start with "+": ${line.trim()}`
        );
      }
      continue;
    }

    if (line.startsWith("@@")) {
      // Stacked `@@` markers narrow the same hunk rather than opening a new one.
      if (hunk && hunk.lines.length === 0) {
        hunk.marker = line.slice(2).trim() || hunk.marker;
        continue;
      }
      closeHunk();
      hunk = { marker: line.slice(2).trim(), lines: [] };
      continue;
    }

    if (!hunk) {
      if (line.trim().length === 0) {
        continue;
      }
      hunk = { marker: "", lines: [] };
    }

    if (line.startsWith(" ")) {
      hunk.lines.push({ tag: " ", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ tag: "-", text: line.slice(1) });
    } else if (line.startsWith("+")) {
      hunk.lines.push({ tag: "+", text: line.slice(1) });
    } else if (line.length === 0) {
      // Models routinely drop the leading space on a blank context line.
      hunk.lines.push({ tag: " ", text: "" });
    } else {
      throw new ApplyPatchEnvelopeError(
        `Hunk line for ${current.path} starts with neither space, "-", nor "+": ${line}`
      );
    }
  }

  closeHunk();
  if (current) {
    operations.push(current);
  }
  if (operations.length === 0) {
    throw new ApplyPatchEnvelopeError("Envelope contains no file operations.");
  }
  return operations;
}

function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, -1) : content;
  return { lines: body.length === 0 && trailingNewline ? [""] : body.split("\n"), trailingNewline };
}

async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<string> {
  const absolute = resolve(workspaceRoot, path);
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) {
    throw new ApplyPatchEnvelopeError(`Envelope names a path outside the workspace: ${path}`);
  }
  try {
    return await readFile(absolute, "utf8");
  } catch {
    throw new ApplyPatchEnvelopeError(`Envelope updates ${path}, which is not in the workspace.`);
  }
}

/**
 * Locates a hunk by matching its context and removed lines against the file. Exactly one
 * match is required: a hunk that could land in more than one place is reported rather than
 * guessed at, because a patch applied cleanly in the wrong location is worse than one that
 * fails loudly.
 */
function locateHunk(fileLines: string[], hunk: Hunk, cursor: number, path: string): number {
  const original = hunk.lines.filter((line) => line.tag !== "+").map((line) => line.text);
  if (original.length === 0) {
    throw new ApplyPatchEnvelopeError(
      `Hunk for ${path} has no context or removed lines, so its position cannot be determined.`
    );
  }

  const matches: number[] = [];
  for (let start = cursor; start + original.length <= fileLines.length; start += 1) {
    if (original.every((text, offset) => fileLines[start + offset] === text)) {
      matches.push(start);
    }
  }

  if (matches.length === 0) {
    throw new ApplyPatchEnvelopeError(`Hunk for ${path} does not match the file content.`);
  }
  if (matches.length === 1) {
    return matches[0] as number;
  }

  if (hunk.marker) {
    const markerIndex = fileLines.findIndex(
      (line, index) => index >= cursor && line.trim() === hunk.marker
    );
    if (markerIndex !== -1) {
      const guided = matches.find((match) => match >= markerIndex);
      if (guided !== undefined) {
        return guided;
      }
    }
  }
  throw new ApplyPatchEnvelopeError(
    `Hunk for ${path} matches ${matches.length} locations; its context is not unique.`
  );
}

interface PlacedHunk {
  start: number;
  lines: HunkLine[];
}

/** Lines of real file context to put either side of a translated hunk. */
const contextRadius = 3;

function oldLength(lines: HunkLine[]): number {
  return lines.filter((line) => line.tag !== "+").length;
}

function newLength(lines: HunkLine[]): number {
  return lines.filter((line) => line.tag !== "-").length;
}

/**
 * Pads each hunk with real context read from the file. This is not cosmetic: Git sets
 * `match_end` when a hunk has no trailing context, which requires the hunk to match at
 * end of file, so an unpadded mid-file hunk is rejected however correct its line numbers
 * are. Padding produces an ordinary diff instead of reaching for `--unidiff-zero`, which
 * would buy the same result by disabling the matching Git does to keep us honest.
 */
function updateDiff(
  path: string,
  hunks: Hunk[],
  fileLines: string[],
  trailingNewline: boolean
): string[] {
  let placed: PlacedHunk[];
  let cursor = 0;
  try {
    placed = hunks.map((hunk) => {
      const start = locateHunk(fileLines, hunk, cursor, path);
      cursor = start + oldLength(hunk.lines);
      return { start, lines: hunk.lines };
    });
  } catch (orderedError) {
    try {
      placed = hunks.map((hunk) => ({
        start: locateHunk(fileLines, hunk, 0, path),
        lines: hunk.lines
      }));
    } catch {
      throw orderedError;
    }
  }
  placed.sort((left, right) => left.start - right.start);

  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1] as PlacedHunk;
    const current = placed[index] as PlacedHunk;
    if (current.start < previous.start + oldLength(previous.lines)) {
      throw new ApplyPatchEnvelopeError(`Hunks for ${path} overlap after ordering.`);
    }
  }

  // Hunks closer together than twice the radius would pad into each other and overlap,
  // which Git rejects. Absorb the lines between them as context and emit one hunk.
  const merged: PlacedHunk[] = [];
  for (const hunk of placed) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const previousEnd = previous.start + oldLength(previous.lines);
      if (hunk.start - previousEnd <= contextRadius * 2) {
        for (let index = previousEnd; index < hunk.start; index += 1) {
          previous.lines.push({ tag: " ", text: fileLines[index] as string });
        }
        previous.lines.push(...hunk.lines);
        continue;
      }
    }
    merged.push({ start: hunk.start, lines: [...hunk.lines] });
  }

  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let offset = 0;
  for (const hunk of merged) {
    const end = hunk.start + oldLength(hunk.lines);
    const lead = Math.min(contextRadius, hunk.start);
    const trail = Math.min(contextRadius, fileLines.length - end);

    const entries: { line: string; onOld: boolean; onNew: boolean }[] = [];
    for (let index = hunk.start - lead; index < hunk.start; index += 1) {
      entries.push({ line: ` ${fileLines[index]}`, onOld: true, onNew: true });
    }
    for (const line of hunk.lines) {
      entries.push({
        line: `${line.tag}${line.text}`,
        onOld: line.tag !== "+",
        onNew: line.tag !== "-"
      });
    }
    for (let index = end; index < end + trail; index += 1) {
      entries.push({ line: ` ${fileLines[index]}`, onOld: true, onNew: true });
    }

    const oldCount = lead + oldLength(hunk.lines) + trail;
    const newCount = lead + newLength(hunk.lines) + trail;
    const oldStart = hunk.start - lead + 1;
    out.push(`@@ -${oldStart},${oldCount} +${oldStart + offset},${newCount} @@`);

    const body = entries.map((entry) => entry.line);
    // A file with no final newline needs the marker after whichever emitted line is last
    // on each side, or Git reads the patch as adding a newline and refuses it.
    if (!trailingNewline && end + trail === fileLines.length) {
      const lastOld = entries.reduce((last, entry, index) => (entry.onOld ? index : last), -1);
      const lastNew = entries.reduce((last, entry, index) => (entry.onNew ? index : last), -1);
      const targets = [...new Set([lastOld, lastNew])].filter((i) => i >= 0).sort((a, b) => b - a);
      for (const index of targets) {
        body.splice(index + 1, 0, noNewlineMarker);
      }
    }
    out.push(...body);

    offset += newLength(hunk.lines) - oldLength(hunk.lines);
  }
  return out;
}

function addDiff(path: string, lines: string[]): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ];
}

function deleteDiff(path: string, fileLines: string[], trailingNewline: boolean): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${fileLines.length} +0,0 @@`,
    ...fileLines.map((line) => `-${line}`),
    ...(trailingNewline ? [] : [noNewlineMarker])
  ];
}

/**
 * Converts an `apply_patch` envelope into the equivalent unified diff, reading the
 * workspace to recover the line numbers the envelope omits. Throws
 * `ApplyPatchEnvelopeError` with a diagnostic an agent can act on when the envelope
 * cannot be translated faithfully.
 */
export async function translateApplyPatchEnvelope(
  patch: string,
  workspaceRoot: string
): Promise<EnvelopeTranslation> {
  const root = resolve(workspaceRoot);
  const operations = parseEnvelope(patch);
  const lines: string[] = [];
  const paths: string[] = [];

  for (const operation of operations) {
    paths.push(operation.path);
    if (operation.kind === "add") {
      lines.push(...addDiff(operation.path, operation.lines));
      continue;
    }
    const content = await readWorkspaceFile(root, operation.path);
    const { lines: fileLines, trailingNewline } = splitLines(content);
    lines.push(
      ...(operation.kind === "delete"
        ? deleteDiff(operation.path, fileLines, trailingNewline)
        : updateDiff(operation.path, operation.hunks, fileLines, trailingNewline))
    );
  }

  return { patch: `${lines.join("\n")}\n`, paths: [...new Set(paths)] };
}
