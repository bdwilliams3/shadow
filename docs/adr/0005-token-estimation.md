# ADR 0005: Token Estimation

## Status

Accepted

## Decision

Before a provider call, Shadow estimates text tokens with a provider-selectable estimator. The OpenAI-compatible baseline uses UTF-8 byte length divided by four, rounded up, plus a configurable 10 percent safety margin. Providers may replace this with an exact tokenizer without changing the router contract.

The router checks estimated input, requested maximum output, stage totals, run totals, estimated price, and the reserved frontier allowance before dispatch. Actual provider usage replaces estimates in the ledger after a response.

## Consequences

- Budget enforcement works before provider-specific tokenizers are integrated.
- Conservative estimates may reject a call that would have fit; the audit record must preserve the estimate and reason.
- Estimation accuracy becomes a benchmark metric and can improve independently by provider.
