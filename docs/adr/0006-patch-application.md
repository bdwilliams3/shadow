# ADR 0006: Patch Application And Conflicts

## Status

Accepted

## Decision

Develop agents produce a schema-constrained unified diff as an artifact. Shadow validates the diff with a registered `git apply --check` action, verifies every affected path remains inside the workspace and is allowed by the stage, then applies it with a separate workspace-write action.

Shadow does not ask Git to perform a three-way merge automatically in the MVP. A conflict returns compact diagnostics to Develop for one bounded retry. Existing user changes are never reset or discarded.

The ordinary patch action rejects file deletion, symlink mode changes, binary patches, paths outside the workspace, and changes to files outside the context selected for that model call. Those operations require separate actions with their own risk classification and approval path.

## Consequences

- Model output cannot write files directly or bypass the tool gateway.
- Check and apply actions create distinct audit records and approval decisions.
- Complex conflicts require a new patch or user intervention rather than implicit merge behavior.
