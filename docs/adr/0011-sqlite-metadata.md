# ADR 0011: SQLite Metadata Store

## Status

Accepted

## Decision

Shadow stores run snapshots and ordered audit events in a local SQLite database at `.shadow/shadow.db`. The implementation uses Node.js 22's built-in `node:sqlite` module, WAL journaling, foreign keys, a busy timeout, strict tables, and `BEGIN IMMEDIATE` transactions for state changes that must merge cross-process approval or cancellation updates.

Existing `.shadow/runs/<id>/run.json` and `events.jsonl` records are imported once on first use. JSONL remains an export format through `shadow logs`; it is no longer the source of truth. Large command output remains in the content-addressed artifact store.

## Consequences

- Run updates and their control records can be committed atomically.
- Concurrent CLI processes cannot silently replace a persisted cancellation or approval decision with stale orchestration state.
- Shadow adds no native addon dependency and retains the Intel and Apple Silicon Node.js package baseline.
- The legacy file store remains available only for migration and compatibility tests.
