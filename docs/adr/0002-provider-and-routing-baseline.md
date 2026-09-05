# ADR 0002: Provider And Routing Baseline

## Status

Accepted

## Decision

Shadow will expose a provider-neutral `ModelProvider` interface and begin with an OpenAI-compatible HTTP adapter. Orchestration code selects capability tiers such as `frontier`, `balanced`, and `economy`; it does not hard-code commercial model names.

Authentication is read from environment variables first. Repository configuration may name providers and aliases, but it must not contain secret values.

### Amendment 2026-09-05: transport deadline

Every provider request carries a deadline (`requestTimeoutMs`, default 120 s) independent of the caller's cancellation signal. A benchmark run stalled for 48 minutes at zero CPU on a connection the provider had closed without a response; with no deadline, `fetch` waited indefinitely. Cancellation and deadline are combined with `AbortSignal.any`, and a deadline expiry is reported as such rather than as a generic abort.

## Consequences

- The first runnable harness works without making model calls.
- Model execution can be added behind the router without changing lifecycle agent contracts.
- Token and cost budgets can reject a planned model call before the adapter receives it.
