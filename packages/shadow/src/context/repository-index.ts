import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { minimatch } from "minimatch";
import ts from "typescript";
import { z } from "zod";
import type { ProcessResult } from "../tools/types.js";

const excludedDirectories = new Set([
  ".git",
  ".shadow",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "vendor"
]);

const textExtensions = new Set([
  ".c", ".cpp", ".cs", ".css", ".go", ".graphql", ".h", ".html", ".java", ".js",
  ".jsx", ".json", ".kt", ".md", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql",
  ".swift", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"
]);

const textNames = new Set(["AGENTS.md", "Dockerfile", "Gemfile", "Makefile"]);
const manifestNames = new Set([
  "Cargo.toml",
  "Gemfile",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt"
]);

const languageByExtension: Record<string, string> = {
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".graphql": "GraphQL",
  ".h": "C/C++ Header",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".mjs": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".sh": "Shell",
  ".sql": "SQL",
  ".swift": "Swift",
  ".toml": "TOML",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".txt": "Text",
  ".xml": "XML",
  ".yaml": "YAML",
  ".yml": "YAML"
};

export interface IndexedFile {
  path: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  language: string;
  symbols: string[];
  imports: string[];
}

interface IndexedFileWithContent extends IndexedFile {
  content: string;
}

interface IndexRow {
  path: string;
  sha256: string;
  bytes: number;
  mtime_ms: number;
  language: string;
  symbols_json: string;
  imports_json: string;
}

interface SearchRow extends IndexRow {
  rank: number;
}

export interface RepositoryDiscovery {
  paths: string[];
  source: "git" | "filesystem";
  commands: string[][];
  stdout: string;
  stderr: string;
}

export interface RepositoryIndexSummary {
  fileCount: number;
  indexedFileCount: number;
  updatedFiles: number;
  removedFiles: number;
  unchangedFiles: number;
  source: "git" | "filesystem";
  truncated: boolean;
  languages: Record<string, number>;
  manifests: string[];
  sampleFiles: string[];
  commands: string[][];
  stdout: string;
  stderr: string;
}

export interface RepositoryIndexOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  exclusions?: string[];
  execute(command: string[], options?: { stdin?: string }): Promise<ProcessResult>;
}

export class RepositoryIndex {
  private readonly database: DatabaseSync;
  private readonly workspaceRoot: string;
  private readonly selectFiles: StatementSync;
  private readonly selectFile: StatementSync;
  private readonly upsertFile: StatementSync;
  private readonly deleteFile: StatementSync;
  private readonly deleteFtsFile: StatementSync;
  private readonly insertFtsFile: StatementSync;

  constructor(
    databasePath: string,
    workspaceRoot: string
  ) {
    this.workspaceRoot = realpathSync(workspaceRoot);
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS repository_files (
        workspace_root TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        language TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        imports_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_root, path)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS repository_files_fts USING fts5(
        workspace_root UNINDEXED,
        path,
        symbols,
        imports,
        content,
        tokenize = 'unicode61'
      );
    `);
    this.selectFiles = this.database.prepare(`
      SELECT path, sha256, bytes, mtime_ms, language, symbols_json, imports_json
      FROM repository_files WHERE workspace_root = ? ORDER BY path
    `);
    this.selectFile = this.database.prepare(`
      SELECT path, sha256, bytes, mtime_ms, language, symbols_json, imports_json
      FROM repository_files WHERE workspace_root = ? AND path = ?
    `);
    this.upsertFile = this.database.prepare(`
      INSERT INTO repository_files (
        workspace_root, path, sha256, bytes, mtime_ms, language, symbols_json, imports_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_root, path) DO UPDATE SET
        sha256 = excluded.sha256,
        bytes = excluded.bytes,
        mtime_ms = excluded.mtime_ms,
        language = excluded.language,
        symbols_json = excluded.symbols_json,
        imports_json = excluded.imports_json,
        indexed_at = excluded.indexed_at
    `);
    this.deleteFile = this.database.prepare(
      "DELETE FROM repository_files WHERE workspace_root = ? AND path = ?"
    );
    this.deleteFtsFile = this.database.prepare(
      "DELETE FROM repository_files_fts WHERE workspace_root = ? AND path = ?"
    );
    this.insertFtsFile = this.database.prepare(`
      INSERT INTO repository_files_fts (workspace_root, path, symbols, imports, content)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  listFiles(): IndexedFile[] {
    return (this.selectFiles.all(this.workspaceRoot) as unknown as IndexRow[]).map(parseIndexRow);
  }

  getFile(path: string): IndexedFile | undefined {
    const row = this.selectFile.get(this.workspaceRoot, path) as unknown as IndexRow | undefined;
    return row ? parseIndexRow(row) : undefined;
  }

  search(query: string, limit = 30): Array<IndexedFile & { score: number }> {
    const terms = lexicalTerms(query);
    if (terms.length === 0) {
      return this.listFiles().slice(0, limit).map((file) => ({ ...file, score: 0 }));
    }
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
    const statement = this.database.prepare(`
      SELECT f.path, f.sha256, f.bytes, f.mtime_ms, f.language, f.symbols_json, f.imports_json,
             bm25(repository_files_fts, 0.0, 8.0, 5.0, 3.0, 1.0) AS rank
      FROM repository_files AS f
      JOIN repository_files_fts AS search ON search.workspace_root = f.workspace_root AND search.path = f.path
      WHERE repository_files_fts MATCH ? AND f.workspace_root = ?
      ORDER BY rank, f.path
      LIMIT ?
    `);
    return (statement.all(expression, this.workspaceRoot, limit) as unknown as SearchRow[]).map((row) => ({
      ...parseIndexRow(row),
      score: -row.rank
    }));
  }

  replace(changed: IndexedFileWithContent[], removedPaths: string[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const path of removedPaths) {
        this.deleteFtsFile.run(this.workspaceRoot, path);
        this.deleteFile.run(this.workspaceRoot, path);
      }
      const indexedAt = new Date().toISOString();
      for (const file of changed) {
        this.deleteFtsFile.run(this.workspaceRoot, file.path);
        this.upsertFile.run(
          this.workspaceRoot,
          file.path,
          file.sha256,
          file.bytes,
          file.mtimeMs,
          file.language,
          JSON.stringify(file.symbols),
          JSON.stringify(file.imports),
          indexedAt
        );
        this.insertFtsFile.run(
          this.workspaceRoot,
          file.path,
          file.symbols.join(" "),
          file.imports.join(" "),
          file.content
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export async function refreshRepositoryIndex(
  workspaceRoot: string,
  databasePath: string,
  options: RepositoryIndexOptions
): Promise<RepositoryIndexSummary> {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const discovery = await discoverRepositoryFiles(
    workspaceRoot,
    maxFiles,
    options.execute,
    options.exclusions ?? []
  );
  const index = new RepositoryIndex(databasePath, workspaceRoot);
  try {
    const existing = new Map(index.listFiles().map((file) => [file.path, file]));
    const candidatePaths = discovery.paths.filter(isIndexableTextPath);
    const loaded = (await mapConcurrent(candidatePaths, 16, async (path) => {
      const absolute = resolve(workspaceRoot, path);
      try {
        const metadata = await lstat(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxFileBytes) {
          return undefined;
        }
        const canonical = await realpath(absolute);
        if (!isInsideWorkspace(workspaceRoot, canonical)) {
          return undefined;
        }
        const content = await readFile(canonical);
        if (content.includes(0)) {
          return undefined;
        }
        const sha256 = createHash("sha256").update(content).digest("hex");
        const prior = existing.get(path);
        if (prior?.sha256 === sha256) {
          return { unchanged: true as const, path };
        }
        return {
          unchanged: false as const,
          path,
          sha256,
          bytes: content.byteLength,
          mtimeMs: metadata.mtimeMs,
          language: languageForPath(path),
          content: content.toString("utf8")
        };
      } catch {
        return undefined;
      }
    })).filter((entry) => entry !== undefined);

    const changedBase = loaded.filter((entry) => !entry.unchanged);
    const python = await extractPythonMetadata(
      changedBase.filter((file) => file.language === "Python").map((file) => ({ path: file.path, content: file.content })),
      options.execute
    );
    const changed: IndexedFileWithContent[] = changedBase.map((file) => {
      const metadata = file.language === "Python"
        ? python.get(file.path) ?? { symbols: [], imports: [] }
        : extractSourceMetadata(file.path, file.content, file.language);
      return { ...file, ...metadata };
    });
    const currentPaths = new Set(loaded.map((entry) => entry.path));
    const removedPaths = [...existing.keys()].filter((path) => !currentPaths.has(path));
    index.replace(changed, removedPaths);

    const languages: Record<string, number> = {};
    for (const path of discovery.paths) {
      const language = languageForPath(path);
      if (language !== "Unknown") {
        languages[language] = (languages[language] ?? 0) + 1;
      }
    }
    return {
      fileCount: discovery.paths.length,
      indexedFileCount: currentPaths.size,
      updatedFiles: changed.length,
      removedFiles: removedPaths.length,
      unchangedFiles: loaded.length - changed.length,
      source: discovery.source,
      truncated: discovery.paths.length >= maxFiles,
      languages,
      manifests: discovery.paths.filter((path) => manifestNames.has(basename(path))),
      sampleFiles: discovery.paths.slice(0, 50),
      commands: discovery.commands,
      stdout: discovery.stdout,
      stderr: discovery.stderr
    };
  } finally {
    index.close();
  }
}

export async function discoverRepositoryFiles(
  workspaceRoot: string,
  maxFiles: number,
  execute: RepositoryIndexOptions["execute"],
  exclusions: string[] = []
): Promise<RepositoryDiscovery> {
  const commands: string[][] = [];
  let stdout = "";
  let stderr = "";
  if (existsSync(resolve(workspaceRoot, ".git"))) {
    const command = ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
    commands.push(command);
    try {
      const result = await execute(command);
      stdout = result.stdout;
      stderr = result.stderr;
      if (result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded) {
        return {
          paths: result.stdout
            .split("\0")
            .filter((path) => isRelevantRepositoryPath(path, exclusions))
            .slice(0, maxFiles)
            .sort(),
          source: "git",
          commands,
          stdout,
          stderr
        };
      }
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    paths: await walkFiles(workspaceRoot, maxFiles, exclusions),
    source: "filesystem",
    commands,
    stdout,
    stderr
  };
}

export function isIndexableTextPath(path: string): boolean {
  return isRelevantRepositoryPath(path) &&
    (textExtensions.has(extname(path).toLowerCase()) || textNames.has(basename(path)));
}

export function languageForPath(path: string): string {
  return languageByExtension[extname(path).toLowerCase()] ?? "Unknown";
}

export function lexicalTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])]
    .filter((term) => !stopWords.has(term))
    .slice(0, 20);
}

export function resolveRepositoryIndexPath(workspaceRoot: string, configuredPath: string): string {
  const path = resolve(workspaceRoot, configuredPath);
  const internalRoot = resolve(workspaceRoot, ".shadow");
  if (path !== internalRoot && !path.startsWith(`${internalRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Repository index database must be stored under .shadow.");
  }
  return path;
}

const stopWords = new Set([
  "add", "and", "change", "create", "fix", "for", "from", "implement", "into", "that", "the", "this", "with"
]);

function isRelevantRepositoryPath(path: string, exclusions: string[] = []): boolean {
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    return false;
  }
  const segments = path.split("/");
  return !segments.some((segment) => excludedDirectories.has(segment)) &&
    !path.endsWith(".lock") &&
    !path.endsWith("-lock.json") &&
    path !== "pnpm-lock.yaml" &&
    !isExcluded(path, exclusions);
}

function isExcluded(path: string, exclusions: string[]): boolean {
  return exclusions.some((pattern) => minimatch(path, pattern, { dot: true }));
}

async function walkFiles(root: string, maxFiles: number, exclusions: string[]): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles || entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name) && !isExcluded(path, exclusions)) await visit(absolute);
      } else if (entry.isFile()) {
        if (isRelevantRepositoryPath(path, exclusions)) files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function parseIndexRow(row: IndexRow): IndexedFile {
  return {
    path: row.path,
    sha256: row.sha256,
    bytes: row.bytes,
    mtimeMs: row.mtime_ms,
    language: row.language,
    symbols: z.array(z.string()).parse(JSON.parse(row.symbols_json)),
    imports: z.array(z.string()).parse(JSON.parse(row.imports_json))
  };
}

function extractSourceMetadata(
  path: string,
  content: string,
  language: string
): { symbols: string[]; imports: string[] } {
  if (language === "TypeScript" || language === "JavaScript") {
    return extractTypeScriptMetadata(path, content);
  }
  const symbols = [...content.matchAll(/\b(?:class|def|enum|fn|function|interface|struct|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .flatMap((match) => match[1] ? [match[1]] : [])
    .slice(0, 200);
  return { symbols: [...new Set(symbols)], imports: [] };
}

function extractTypeScriptMetadata(path: string, content: string): { symbols: string[]; imports: string[] } {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX
    : path.endsWith(".jsx") ? ts.ScriptKind.JSX
      : path.endsWith(".js") || path.endsWith(".mjs") ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const symbols = new Set<string>();
  const imports = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name
    ) {
      symbols.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.add(node.name.text);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { symbols: [...symbols].slice(0, 200), imports: [...imports].slice(0, 200) };
}

const PythonMetadataSchema = z.record(
  z.string(),
  z.object({ symbols: z.array(z.string()), imports: z.array(z.string()) })
);

const pythonExtractor = [
  "import ast, json, sys",
  "items = json.load(sys.stdin)",
  "out = {}",
  "for item in items:",
  "    symbols, imports = [], []",
  "    try:",
  "        tree = ast.parse(item['content'], filename=item['path'])",
  "        for node in ast.walk(tree):",
  "            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):",
  "                symbols.append(node.name)",
  "            elif isinstance(node, ast.Import):",
  "                imports.extend(alias.name for alias in node.names)",
  "            elif isinstance(node, ast.ImportFrom) and node.module:",
  "                imports.append(node.module)",
  "    except (SyntaxError, ValueError):",
  "        pass",
  "    out[item['path']] = {'symbols': list(dict.fromkeys(symbols))[:200], 'imports': list(dict.fromkeys(imports))[:200]}",
  "json.dump(out, sys.stdout)"
].join("\n");

async function extractPythonMetadata(
  files: Array<{ path: string; content: string }>,
  execute: RepositoryIndexOptions["execute"]
): Promise<Map<string, { symbols: string[]; imports: string[] }>> {
  if (files.length === 0) return new Map();
  try {
    const result = await execute(["python3", "-c", pythonExtractor], { stdin: JSON.stringify(files) });
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) return new Map();
    return new Map(Object.entries(PythonMetadataSchema.parse(JSON.parse(result.stdout))));
  } catch {
    return new Map();
  }
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const path = relative(workspaceRoot, candidate);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<U>
): Promise<U[]> {
  const output: U[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(values[index]!);
    }
  }));
  return output;
}
