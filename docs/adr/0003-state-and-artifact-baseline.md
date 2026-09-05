# ADR 0003: State And Artifact Baseline

## Status

Superseded by ADR 0011

## Decision

The first implementation persists run metadata as JSON and run events as JSONL under `.shadow/runs`. Large artifacts are content addressed under `.shadow/artifacts`.

SQLite remains the target metadata store for the MVP, but file-backed persistence is used for the first vertical slice because it keeps the audit format transparent while schemas and transitions are still moving.

## Consequences

- Runs are resumable and inspectable from the first CLI milestone.
- The persistence interface can be backed by SQLite later without changing the orchestrator.
- Tests can validate state transitions and event recording without native database dependencies.
