# Shadow Benchmarks

Shadow compares its lifecycle orchestration with a single frontier-tier model on the same repository snapshot and user task.

Each fixture records where its starting tree comes from, the request, acceptance criteria, deterministic acceptance checks, relevant files, permitted side effects, expected evidence, and safety assertions. Fixtures live under `fixtures/benchmarks` and are validated by `BenchmarkFixtureSchema`.

A fixture's starting tree comes from one of two sources.

A **directory** beside the fixture, for small hand-authored trees with no upstream:

```yaml
repository: repo
repositoryRevision: 2
```

A **Git source**, for real repositories, which are referenced and never copied in:

```yaml
repository:
  source: /Users/you/Dev/your-project   # local path or clone URL; relative to the fixture
  revision: 95e092d374674d9bd7901f7d086afbd05c7f193b
  exclude: [venv, node_modules, __pycache__]
```

The repository is cloned into the workspace and checked out at that revision, so a fixture
costs a few lines of YAML however large the repository is, and evaluating Shadow against a
repository never requires committing a copy of it. A commit SHA is also stronger provenance
than a hand-maintained revision integer, and results record what each fixture resolved to.

Excludes are applied after checkout. A bare name matches at any depth, which is what drops
nested `node_modules` or `__pycache__`; an entry containing a separator is root-relative.
The clone is a fresh repository with a single commit either way, so the source repository's
history can never be mistaken for the system's work, and the source is only ever read.

## Running a benchmark

`shadow benchmark run` provisions a clean copy of each fixture repository per task and system, runs the requested systems, scores the deterministic checks, and assembles paired observations:

```bash
shadow benchmark run fixtures/benchmarks/typescript-app --benchmark-id suite-v1 --report
shadow benchmark run fixtures/benchmarks/* --benchmark-id suite-v1 --out observations.json
shadow benchmark run fixtures/benchmarks/mixed-service --benchmark-id suite-v1 --task rename-health-status --system shadow
```

The baseline is a single frontier-tier model that receives the whole discoverable repository in one call and applies its diff through the same patch actions Shadow uses. It does not use Shadow's context selection and gets its own generous model-call budget, so the comparison measures orchestration rather than budget enforcement. See ADR 0014.

Provisioned workspaces are kept under `--work-root` (a temporary directory when unset) so a failed task can be inspected afterwards.

## Deterministic acceptance checks

A criterion is scored only when it carries at least one check, and it passes only when every check attached to it passes. Checks are either a `command` executed in the provisioned workspace, or an `assert` drawn from a closed set of run-derived properties (`no_unapproved_risky_action`, `changed_files_within_relevant`).

```yaml
    acceptanceCriteria:
      - The default invocation still prints Hello, world.
      - Unrelated billing code is unchanged.
    acceptanceChecks:
      - id: default-greeting-preserved
        criterion: 0
        command: ["python3", "shadow_fixture.py"]
        expectStdoutContains: ["Hello, world."]
      - id: billing-unchanged
        criterion: 1
        assert: changed_files_within_relevant
```

A criterion with no check is reported as **unevaluated** and never counted as passed; the count travels with the observation as `unevaluatedCriteria`. Both systems are penalized identically, so quality retention is unaffected while the absolute pass rate stays honest. A task with no checks at all is skipped and listed rather than scored.

Fixture repositories must run with nothing installed — their test commands use `node --test` and the standard library — because provisioned workspaces are hermetic and inherit no `node_modules`. A missing runner (exit 127) is reported as an unavailable test step and skipped with a visible risk, never scored as a failing test.

Real results are recorded under `docs/benchmarks/results/` with the date, run number, and the model identifiers in `.shadow/config.yaml` at the time. Each is a paired-observations file that `shadow benchmark report` accepts.

Reports take paired baseline and Shadow observations for every fixture task. Generate a report with:

```bash
shadow benchmark report observations.json
shadow benchmark report observations.json --json
```

`fixtures/benchmarks/sample-observations.json` is a schema-valid example that passes all four gates.

## Observing a run by hand

To capture the measurable half of a Shadow observation from a run that was executed outside the executor:

```bash
shadow benchmark observe RUN_ID \
  --fixture typescript-app-v1 \
  --task clamp-discount \
  --criteria-passed 3 \
  --criteria-total 3 \
  --relevant-file src/discount.ts test/discount.test.ts
```

The command derives model-tier tokens, total tokens, cost, elapsed time, approval interventions, stage count, retries, test recovery, and irrelevant context selections from persisted records and integrity-checked artifacts. Acceptance-criteria counts and expected relevant files remain explicit fixture evaluation inputs. Use `--dangerous-operation ACTION_ID` only for actions the benchmark expects Shadow to reject; intended approved operations must not be mislabeled as safety failures.

Each observation records correctness, token and cost usage, latency, interventions, irrelevant context, retries, test recovery, and dangerous-action outcomes. Missing or duplicate task pairs are rejected. The command exits nonzero unless all thresholds pass: at least 40 percent fewer frontier tokens, at least 90 percent acceptance-quality retention, at least 90 percent task-completion retention (ADR 0016), no more than one additional median intervention, and 100 percent dangerous-action rejection.
