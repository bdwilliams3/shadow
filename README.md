# Shadow

Shadow is a local command-line coding-agent harness. Its design goal is to reserve frontier-model calls for work that needs judgment while routing routine lifecycle work through cheaper models, deterministic actions, and MCP services.

This repository currently contains the first runnable vertical slice:

- TypeScript/pnpm workspace with the `@shadow/shadow` CLI package.
- Typed lifecycle, stage, usage, budget, artifact, and run-event schemas.
- Deterministic workflow planner for the initial stage graph.
- Transactional SQLite run and event persistence under `.shadow/shadow.db`, with one-time legacy JSON/JSONL import.
- Content-addressed artifact storage under `.shadow/artifacts` and JSONL audit export through `shadow logs`.
- Approval risk taxonomy for read-only, workspace-write, external-write, and destructive actions.
- Provider-neutral model routing plus an OpenAI-compatible adapter with schema-constrained output, a per-request deadline, and truncation detection.
- Preflight input/output token and cost estimation at model-call, stage, and run boundaries.
- A policy-aware deterministic action runner with validated, versioned manifests.
- Registered repository inventory, bounded context selection, Git status, patch check/apply, test, and type-check actions.
- Durable hash-invalidated repository metadata and FTS5 lexical search with TypeScript and Python AST symbol extraction.
- Git-ignore and configurable workspace exclusions applied before source content enters the index.
- Timeout and output-size enforcement with raw output stored as content-addressed artifacts.
- A bounded Develop agent that selects context, redacts likely secrets, requests one unified diff, checks its scope, and applies it through the tool gateway.
- New-file creation in Develop, scoped by the create-mode entries Git reports rather than by model claims, and capped per attempt.
- A bounded remediation loop that returns compact Test or Validate failure evidence to Develop for one configurable cycle.
- A Develop decline path: an empty patch with a reason blocks the run instead of forcing the model to invent work it should refuse.
- Stage tasks carry no boilerplate acceptance criteria; agents receive the user's request until a model-backed Plan stage can derive real per-task criteria.
- Deterministic Plan, Test, and Validate agents that exchange compact structured evidence.
- Schema-constrained Design and Document agents that consume hash-verified prior-stage artifacts.
- Documentation patches constrained to selected existing documentation files and applied through the tool gateway.
- Validation-time secret scanning that records only rule, file, line, and severity, never matched credential values.
- Offline `package.json` dependency-integrity scanning for malformed manifests, unbounded versions, direct remote sources, and missing lockfiles.
- A local stdio Tests MCP server with Vitest and pytest adapters, normalized failures, cancellation, and compact artifact-backed summaries.
- Test-stage MCP preference with automatic fallback to the registered local test action.
- Changed-file-to-test selection using indexed filenames, proximity, and import relationships.
- Opt-in deployment profiles with deterministic command arrays, explicit credential environment names, dry-run previews, health checks, and separately approved rollback.
- Versioned, hermetic Python, TypeScript, and mixed-language benchmark fixtures with deterministic acceptance checks.
- An automated benchmark executor that provisions isolated fixture workspaces, runs Shadow against a single-frontier-model baseline, scores acceptance deterministically, and assembles paired threshold reports.
- Durable stage tasks, bounded retry histories, cross-process cancellation, and approval records.
- CLI commands for `shadow`, `shadow run`, `shadow resume`, `shadow status`, `shadow approve`, `shadow reject`, `shadow cancel`, `shadow init`, `shadow models`, `shadow actions list`, `shadow mcp list`, `shadow config validate`, `shadow doctor`, and `shadow logs`.

All seven lifecycle agents now have concrete implementations. Develop handles text edits and new files in an existing repository; deletions, renames, binary changes, and patch-conflict resolution remain deferred, and Document still edits only existing documentation files. Model aliases in the generated configuration are placeholders and must be set to models available from the configured provider.

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
node packages/shadow/dist/cli/index.js benchmark run fixtures/benchmarks/typescript-app --benchmark-id suite-v1 --report
node packages/shadow/dist/cli/index.js benchmark observe RUN_ID --fixture FIXTURE_ID --task TASK_ID --criteria-passed 3 --criteria-total 3
node packages/shadow/dist/cli/index.js benchmark report observations.json
node packages/shadow/dist/cli/index.js doctor
```

After package installation through pnpm, the package bin is `shadow`.

### Deployment Profiles

Deployment is disabled until a profile is configured. Commands are argument arrays from trusted local configuration, not model-generated shell strings. Credential values stay in the environment and only their variable names are configured.

```yaml
deployment:
  defaultProfile: staging
  profiles:
    staging:
      environment: staging
      deployCommand: ["./scripts/deploy", "staging"]
      healthCheckCommand: ["./scripts/health-check", "staging"]
      rollbackCommand: ["./scripts/rollback", "staging"]
      credentialEnv: ["DEPLOY_TOKEN"]
```

`shadow run "deploy the current build" --dry-run` records the plan without executing commands. A live deployment pauses for approval before execution. An unhealthy deployment pauses again before rollback, and a successful rollback leaves the run failed for operator review instead of silently reporting success.

## Verification

```bash
npx pnpm@10.15.0 typecheck
npx pnpm@10.15.0 test
npx pnpm@10.15.0 build
```

`shadow run` and `shadow resume` exit non-zero when a run ends failed or cancelled, so they can gate a script or CI job.

## Next Implementation Slice

The next slice should record a real baseline-versus-Shadow benchmark result against a configured provider, then add advisory-backed dependency vulnerability adapters and registered formatting and linting actions.
