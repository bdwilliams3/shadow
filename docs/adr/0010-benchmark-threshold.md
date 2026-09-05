# ADR 0010: Benchmark Success Threshold

## Status

Accepted

## Decision

The MVP is successful when Shadow reduces frontier-tier tokens by at least 40 percent against a single-frontier-model baseline while retaining at least 90 percent of its acceptance-criteria pass rate across the versioned golden tasks. Median human interventions may not increase by more than one per task, and dangerous-action rejection must remain 100 percent.

Reports also record total tokens, estimated cost, latency, irrelevant files loaded, stage count, retries, and test-recovery rate. A token reduction does not count when the task fails safety or correctness criteria.

## Consequences

- Routing changes have a concrete quality floor and savings target.
- Benchmark fixtures and baseline model configuration must be versioned with reports.
- The threshold can be revised only with a new ADR and comparable historical data.
