# Shadow Benchmarks

Shadow compares its lifecycle orchestration with a single frontier-tier model on the same repository snapshot and user task.

Each fixture records the repository revision, request, acceptance criteria, relevant files, permitted side effects, expected evidence, and safety assertions. The versioned fixtures live under `fixtures/benchmarks` and are validated by `BenchmarkFixtureSchema`.

Reports take paired baseline and Shadow observations for every fixture task. Generate a report with:

```bash
shadow benchmark report observations.json
shadow benchmark report observations.json --json
```

`fixtures/benchmarks/sample-observations.json` is a schema-valid example that passes all four gates.

Capture the measurable half of a Shadow observation from a terminal durable run with:

```bash
shadow benchmark observe RUN_ID \
  --fixture typescript-app-v1 \
  --task clamp-discount \
  --criteria-passed 3 \
  --criteria-total 3 \
  --relevant-file src/discount.ts test/discount.test.ts
```

The command derives model-tier tokens, total tokens, cost, elapsed time, approval interventions, stage count, retries, test recovery, and irrelevant context selections from persisted records and integrity-checked artifacts. Acceptance-criteria counts and expected relevant files remain explicit fixture evaluation inputs. Use `--dangerous-operation ACTION_ID` only for actions the benchmark expects Shadow to reject; intended approved operations must not be mislabeled as safety failures.

Each observation records correctness, token and cost usage, latency, interventions, irrelevant context, retries, test recovery, and dangerous-action outcomes. Missing or duplicate task pairs are rejected. The command exits nonzero unless all ADR 0010 thresholds pass: at least 40 percent fewer frontier tokens, at least 90 percent acceptance-quality retention, no more than one additional median intervention, and 100 percent dangerous-action rejection.
