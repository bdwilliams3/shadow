# ADR 0004: Approval Risk Taxonomy

## Status

Accepted

## Decision

Shadow classifies tool actions as `read_only`, `workspace_write`, `external_write`, or `destructive`. Default policy allows read-only actions, allows workspace writes only when explicitly permitted by the stage, and requires approval for destructive actions, external writes, deployment, credentials, global installs, and writes outside the active workspace.

## Consequences

- Deterministic tools and MCP tools share one policy vocabulary.
- Risky actions can be rejected before subprocess execution or external side effects.
- Policy decisions are recordable as structured run events.
