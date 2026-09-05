# ADR 0015: Develop Remediation And New-File Creation

## Status

Accepted

## Decision

### Remediation

A Test or Validate stage that exhausts its own retries no longer fails the run outright. The orchestrator writes a compact failure artifact — stage, reason, summary, normalized failures, open risks, changed files, and failed tool summaries — and resumes the stage graph at the earlier Develop stage with that artifact attached to the Develop task inputs. Raw command output stays in its own artifacts and is never inlined into the failure record.

Remediation is bounded by `lifecycle.maxRemediationCycles` (default 1) and is disabled for dry runs and for runs whose Develop stage did not previously complete. Retry and model-call budgets are scoped to the current remediation cycle, so a remediation pass is not immediately blocked by the attempts that triggered it; the run-level token and cost budgets remain the outer bound. Attempt history is preserved across cycles so test-recovery metrics remain derivable.

### New files

Develop may create files. The set of created paths is parsed from `git apply --summary` rather than declared by the model, so a modification can never be presented as a creation to escape the bounded context. A changed file is in scope when it is either part of the selected context or reported by Git as created. Creations are capped at ten per attempt, and the created paths are recorded as stage decisions.

Deletion, symlink changes, and binary patches remain refused, as in ADR 0006.

## Consequences

- Test and validation failures produce a bounded second attempt with evidence instead of ending the run.
- The compact failure artifact is the contract between the failing stage and Develop; growing it grows model context, so it stays summary-shaped.
- Develop can add files without an approval path change, because creation is still a workspace write inside the bounded patch actions.
- Document creation is unchanged: the Document agent still edits only selected existing documentation files.
