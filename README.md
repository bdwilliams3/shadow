# Shadow

Shadow is a local command-line coding-agent harness. Its design goal is to reserve frontier-model calls for work that needs judgment while routing routine lifecycle work through cheaper models, deterministic actions, and MCP services.

This repository currently contains the first runnable vertical slice:

- TypeScript/pnpm workspace with the `@shadow/shadow` CLI package.
- Typed lifecycle, stage, usage, budget, artifact, and run-event schemas.
- Deterministic workflow planner for the initial stage graph.
- Transactional SQLite run and event persistence under `.shadow/shadow.db`, with one-time legacy JSON/JSONL import.
- Content-addressed artifact storage under `.shadow/artifacts` and JSONL audit export through `shadow logs`.
- Approval risk taxonomy for read-only, workspace-write, external-write, and destructive actions.
- Provider-neutral model routing plus an OpenAI-compatible adapter with schema-constrained output.
- Preflight input/output token and cost estimation at model-call, stage, and run boundaries.
- A policy-aware deterministic action runner with validated, versioned manifests.
- Registered repository inventory, bounded context selection, Git status, patch check/apply, test, and type-check actions.
- Durable hash-invalidated repository metadata and FTS5 lexical search with TypeScript and Python AST symbol extraction.
- Git-ignore and configurable workspace exclusions applied before source content enters the index.
- Timeout and output-size enforcement with raw output stored as content-addressed artifacts.
- A bounded Develop agent that selects context, redacts likely secrets, requests one unified diff, checks its scope, and applies it through the tool gateway.
- Deterministic Plan, Test, and Validate agents that exchange compact structured evidence.
- Schema-constrained Design and Document agents that consume hash-verified prior-stage artifacts.
- Documentation patches constrained to selected existing documentation files and applied through the tool gateway.
- A local stdio Tests MCP server with Vitest and pytest adapters, normalized failures, cancellation, and compact artifact-backed summaries.
- Test-stage MCP preference with automatic fallback to the registered local test action.
- Changed-file-to-test selection using indexed filenames, proximity, and import relationships.
- Durable stage tasks, bounded retry histories, cross-process cancellation, and approval records.
- CLI commands for `shadow`, `shadow run`, `shadow resume`, `shadow status`, `shadow approve`, `shadow reject`, `shadow cancel`, `shadow init`, `shadow models`, `shadow actions list`, `shadow mcp list`, `shadow config validate`, `shadow doctor`, and `shadow logs`.

Deploy remains a placeholder. Develop and Document currently handle existing-repository text edits; new-file creation and conflict remediation are intentionally deferred. Model aliases in the generated configuration are placeholders and must be set to models available from the configured provider.

## Setup

```bash
npx pnpm@10.15.0 install
npx pnpm@10.15.0 build
```

`pnpm` is the intended package manager. If it is not installed globally, use `npx pnpm@10.15.0` as shown above.

## Usage

```bash
node packages/shadow/dist/cli/index.js init
node packages/shadow/dist/cli/index.js run "fix a typo" --dry-run
node packages/shadow/dist/cli/index.js status
node packages/shadow/dist/cli/index.js resume RUN_ID
node packages/shadow/dist/cli/index.js approve RUN_ID
node packages/shadow/dist/cli/index.js cancel RUN_ID
node packages/shadow/dist/cli/index.js actions list
node packages/shadow/dist/cli/index.js mcp list
node packages/shadow/dist/cli/index.js doctor
```

After package installation through pnpm, the package bin is `shadow`.

## Verification

```bash
npx pnpm@10.15.0 typecheck
npx pnpm@10.15.0 test
npx pnpm@10.15.0 build
```

## Next Implementation Slice

The next slice should add versioned benchmark fixtures and reports for context relevance, lifecycle correctness, and frontier-token savings. The constrained Deploy agent and dry-run deployment contract can then replace the final placeholder stage.
