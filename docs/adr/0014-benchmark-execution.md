# ADR 0014: Automated Benchmark Execution And Deterministic Acceptance

## Status

Accepted

## Decision

Benchmark runs are executed by a first-class executor rather than assembled by hand. `shadow benchmark run` copies a fixture repository into an isolated workspace per task and system, commits it so every run starts from an identical clean tree, runs the requested systems, scores the task, and assembles paired observations.

Acceptance criteria are scored deterministically. A fixture task may attach checks to any criterion, and a criterion passes only when it carries at least one check and every check for it passes. Two check kinds exist:

- A `command` check runs an argument array in the provisioned workspace and asserts exit code and output substrings. Checks are executed by the benchmark harness, not registered in the default action registry, so a fixture-declared command never becomes a tool an agent can invoke.
- An `assert` check evaluates one of a closed set of run-derived properties: `no_unapproved_risky_action` and `changed_files_within_relevant`.

A criterion with no check is reported as **unevaluated** and is never counted as passed. The observation carries `unevaluatedCriteria` alongside the pass count, so an unverifiable criterion depresses the score instead of being silently credited. Both systems are penalized identically, which leaves the quality-retention ratio in ADR 0010 unaffected by the gap while keeping the absolute pass rate honest. A task with no checks at all is skipped and reported, never scored.

Changed files are read from `git status` in the provisioned workspace rather than from what a system reports about itself. Paths under `.shadow/`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.pytest_cache/`, `__pycache__/` and `.venv/` are excluded: a test or build step creates them, so scoring them as changed files produces false scope failures.

Provisioning removes any existing workspace before copying the fixture. A leftover tree would either fail to commit or, worse, commit a previous run's output as the baseline and make the task look like it changed nothing.

Workspaces provisioned inside the project under test are **not hermetic**: Node and Python resolve packages up the directory tree, so the fixture inherits the project's installed tooling. The default work root is a temporary directory outside the project, and an in-project `--work-root` prints a warning. This is a real limitation, not a solved problem: a fixture whose tests need dependencies behaves differently depending on where the work root points.

The baseline is a single frontier-tier model that receives the whole discoverable repository and the user's request in one call, produces a unified diff, and applies it through the same patch actions Shadow uses. Neither system receives the fixture's acceptance criteria: those are the grader's, and an early version that handed them to the baseline alone tilted the comparison against Shadow. It deliberately does not use Shadow's context selection, and it receives a generous model-call budget of its own: constraining it to Shadow's per-call limits would measure budget enforcement rather than orchestration.

Dangerous-action accounting differs by system because the mechanisms differ. Shadow converts a blocked risky action into an approval gate, so its counts come from approval records; the baseline has no approval gate, so its counts come from blocked tool calls. A rejection rate over zero attempted actions is treated as vacuously satisfied.

## Consequences

- Acceptance scores are reproducible and reviewable rather than operator-supplied.
- Fixture authors are pushed toward checkable criteria; unverifiable ones remain visible as unevaluated rather than disappearing.
- The benchmark exposes real gaps: a criterion describing behavior Shadow does not yet implement stays unevaluated or fails, and no report can pass by omitting it.
- Each fixture task consumes fresh disk per system, and provisioned workspaces are retained under the work root for inspection.
- Fixture repositories must be runnable with nothing installed. The TypeScript fixtures are at repository revision 2 for this reason: their tests use `node --test` and `node:assert` rather than Vitest, which the first hermetic run could not resolve (exit 127) and which the harness then misread as a failing test.
- `safetyAssertions` in a fixture remain descriptive; safety is scored only through the assertion checks above.
- Threshold comparisons use a tolerance. Ratios of exact counts land on boundaries a double cannot represent: 9/12 divided by 10/12 is exactly 0.9 in arithmetic and 0.8999999999999999 in IEEE 754, which failed an exactly-met threshold in the first real run.
- `succeeded` on an observation means the run completed *and* every criterion passed. For a task whose correct outcome is refusing to act, that flag reads false while every criterion passes; read the criteria, not the flag, for such tasks.
