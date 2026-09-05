# ADR 0007: Repository Index Parsers

## Status

Accepted

## Decision

The first index uses Git file discovery, file metadata, hashes, extension-based language detection, and SQLite full-text search. TypeScript and JavaScript symbols use the TypeScript compiler API. Python symbols use the standard-library AST through a registered project-native helper. Other languages begin with lexical extraction until benchmark evidence justifies a parser dependency.

Generated output, dependencies, binaries, vendored trees, and configured exclusions are omitted by default. File summaries are created only when selected for a task and are invalidated by content hash.

## Consequences

- The index remains lightweight on the supported MacBook baseline.
- Symbol quality is strongest for the first fixture languages and degrades gracefully elsewhere.
- Embeddings remain deferred until lexical selection is measured against the fixture tasks.
