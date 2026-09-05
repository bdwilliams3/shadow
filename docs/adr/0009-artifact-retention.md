# ADR 0009: Artifact Retention

## Status

Accepted

## Decision

Run metadata is retained until explicitly removed. Content-addressed artifacts are retained for 30 days after their last referenced run by default. Cleanup is an explicit deterministic action that first reports the candidate files and recoverable byte count; deletion requires approval under the destructive policy.

Pinned runs and artifacts referenced by active or incomplete runs are never automatic cleanup candidates. Secrets are rejected before artifact writes rather than relying on retention to remove them later.

## Consequences

- Audits remain available while large logs have a bounded default lifetime.
- Cleanup is predictable, previewable, and policy controlled.
- Reference tracking must be implemented before automated retention is enabled.
