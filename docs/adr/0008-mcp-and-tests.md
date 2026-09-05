# ADR 0008: MCP And Tests Server Baseline

## Status

Accepted

## Decision

Shadow initially targets MCP protocol revision `2025-11-25` over local stdio and will pin `@modelcontextprotocol/sdk` at `1.30.0` when the MCP package is introduced. The client performs the 2025 `initialize` handshake and capability negotiation. HTTP transport and the stateless `2026-07-28` protocol era are deferred until the v2 TypeScript SDK is adopted.

Tests MCP initially supports Vitest and pytest. It owns process lifecycle, raw logs, truncation, cancellation, and normalized failures. Shadow retains registered local `quality.test` execution as the fallback when the server is absent or unhealthy.

## Consequences

- Protocol upgrades are isolated behind the MCP client abstraction and dependency lockfile.
- Stdio startup avoids the extra discovery process and timeout involved in automatic modern-era probing.
- The TypeScript and Python evaluation fixtures have first-class adapters.
- Test strategy remains in Shadow while high-volume execution details remain outside model context.
