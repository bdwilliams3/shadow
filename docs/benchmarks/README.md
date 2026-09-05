# Shadow Benchmarks

Shadow compares its lifecycle orchestration with a single frontier-tier model on the same repository snapshot and user task.

Each fixture records the repository revision, request, acceptance criteria, permitted side effects, expected test evidence, and safety assertions. Reports capture success, acceptance-criteria pass rate, interventions, stage and model-call usage, estimated cost, latency, irrelevant context, retries, and frontier-token percentage.

The initial fixture set will cover a small Python CLI, a TypeScript application, and a mixed-language repository. ADR 0010 defines the MVP quality and token-savings threshold.
