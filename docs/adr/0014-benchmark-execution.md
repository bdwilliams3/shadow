# ADR 0014: Automated Benchmark Execution And Deterministic Acceptance

## Status

Accepted

## Decision

Benchmark runs are executed by a first-class executor rather than assembled by hand. `shadow benchmark run` copies a fixture repository into an isolated workspace per task and system, commits it so every run starts from an identical clean tree, runs the requested systems, scores the task, and assembles paired observations.

Acceptance criteria are scored deterministically. A fixture task may attach checks to any criterion, and a criterion passes only when it carries at least one check and every check for it passes. Two check kinds exist:

- A `command` check runs an argument array in the provisioned workspace and asserts exit code and output substrings. Checks are executed by the benchmark harness, not registered in the default action registry, so a fixture-declared command never becomes a tool an agent can invoke.
- An `assert` check evaluates one of a closed set of run-derived properties: `no_unapproved_risky_action` and `changed_files_within_relevant`.

A criterion with no check is reported as **unevaluated** and is never counted as passed. The observation carries `unevaluatedCriteria` alongside the pass count, so an unverifiable criterion depresses the score instead of being silently credited. Both systems are penalized identically, which leaves the quality-retention ratio in ADR 0010 unaffected by the gap while keeping the absolute pass rate honest. A task with no checks at all is skipped and reported, never scored.

Changed files are read from `git status` in the provisioned workspace rather than from what a system reports about itself.

The baseline is a single frontier-tier model that receives the whole discoverable repository in one call, produces a unified diff, and applies it through the same patch actions Shadow uses. It deliberately does not use Shadow's context selection, and it receives a generous model-call budget of its own: constraining it to Shadow's per-call limits would measure budget enforcement rather than orchestration.

Dangerous-action accounting differs by system because the mechanisms differ. Shadow converts a blocked risky action into an approval gate, so its counts come from approval records; the baseline has no approval gate, so its counts come from blocked tool calls. A rejection rate over zero attempted actions is treated as vacuously satisfied.

## Consequences

- Acceptance scores are reproducible and reviewable rather than operator-supplied.
- Fixture authors are pushed toward checkable criteria; unverifiable ones remain visible as unevaluated rather than disappearing.
- The benchmark exposes real gaps: a criterion describing behavior Shadow does not yet implement stays unevaluated or fails, and no report can pass by omitting it.
- Each fixture task consumes fresh disk per system, and provisioned workspaces are retained under the work root for inspection.
- `safetyAssertions` in a fixture remain descriptive; safety is scored only through the assertion checks above.
