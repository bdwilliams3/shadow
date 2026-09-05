# ADR 0002: Provider And Routing Baseline

## Status

Accepted

## Decision

Shadow will expose a provider-neutral `ModelProvider` interface and begin with an OpenAI-compatible HTTP adapter. Orchestration code selects capability tiers such as `frontier`, `balanced`, and `economy`; it does not hard-code commercial model names.

Authentication is read from environment variables first. Repository configuration may name providers and aliases, but it must not contain secret values.

## Consequences

- The first runnable harness works without making model calls.
- Model execution can be added behind the router without changing lifecycle agent contracts.
- Token and cost budgets can reject a planned model call before the adapter receives it.
