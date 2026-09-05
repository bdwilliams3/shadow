# ADR 0001: Platform Baseline

## Status

Accepted

## Decision

Shadow targets Node.js `22.11.0` or newer, TypeScript `5.9.x` in strict mode, ESM modules, and pnpm `10.15.0` workspaces. The initial supported hosts are macOS 13 or newer on Intel `x64` and Apple Silicon `arm64`, with validation focused on a 2021 MacBook-class environment.

The initial distribution is a platform-neutral npm package with a `shadow` bin. Native dependencies are avoided until SQLite is introduced; any later native package must ship or build for both target architectures in CI.

## Consequences

- The CLI and harness can use modern Node runtime features without transpiling to older JavaScript.
- Package layout starts as a pnpm monorepo so future MCP servers, deterministic actions, and fixtures can live beside the main CLI.
- Distribution packaging remains deferred until the CLI vertical slice is stable.
