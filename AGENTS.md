# Shadow Implementation Plan

## 1. Product Definition

Shadow is a local command-line coding-agent harness optimized for two goals:

1. Apply frontier-model intelligence only where it materially improves outcomes.
2. Conserve model tokens by delegating routine work to cheaper models, deterministic scripts, and MCP services.

The initial target is a 2021 MacBook running macOS. The architecture must remain portable so additional operating systems and hardware profiles can be added later.

The user experience begins with:

```bash
shadow
```

This opens an interactive terminal chat scoped to the current working directory. The user can request changes to an existing repository or creation of a new project. Shadow plans and executes the work through a configurable software-development lifecycle:

```text
Plan -> Design -> Develop -> Test -> Validate -> Deploy -> Document
```

Each lifecycle stage may use a different model, provider, deterministic script, or MCP server. Stages may be skipped when unnecessary.

## 2. Core Principles

- **Provider-neutral:** Do not couple orchestration to one model vendor.
- **Capability-based routing:** Select models by capability, cost, latency, context size, and tool support rather than hard-coded marketing names.
- **Frontier-model scarcity:** Treat expensive model calls as a limited resource.
- **Deterministic-first execution:** Use local programs for operations that do not require judgment.
- **Structured boundaries:** Agents communicate through typed artifacts, not free-form conversational history.
- **Minimal context:** Give each agent only the files, diffs, decisions, and constraints required for its stage.
- **Local control:** Require explicit policy checks before destructive commands, deployment, network access, or writes outside the workspace.
- **Observable operation:** Record decisions, model usage, token usage, tool calls, costs, artifacts, and failures.
- **Resumability:** Persist workflow state so interrupted runs can continue without replaying the full conversation.
- **Graceful degradation:** The tool must remain useful with one configured model and no optional MCP servers.

## 3. Scope

### MVP

- macOS CLI installation and `shadow` command.
- Interactive terminal chat.
- Existing-repository and new-project workflows.
- Seven configurable lifecycle agents.
- OpenAI-compatible provider adapter plus a generic adapter interface.
- Per-agent model configuration.
- Local shell and filesystem tools with approval controls.
- Git-aware change tracking.
- Tests MCP integration with a local fallback runner.
- Token budgets at run, stage, and model-call levels.
- Structured run artifacts and resumable sessions.
- Dry-run mode.
- Unit, integration, and end-to-end tests.

### Deferred

- Windows and Linux packaging.
- Remote multi-machine execution.
- Hosted control plane.
- Team accounts and shared policy management.
- IDE extensions.
- Autonomous production deployment without approval.
- A marketplace for agents, MCP servers, or workflow templates.

## 4. Recommended Technology

Implement Shadow in TypeScript on Node.js.

Use TypeScript for the core harness because Shadow's primary work is orchestration: streaming terminal chat, provider adapters, MCP calls, subprocess supervision, JSON schemas, plugin-style extension points, and artifact routing. The implementation should favor a clear Node.js service architecture over framework-heavy abstractions.

Recommended baseline:

- Node.js 22 LTS or newer.
- TypeScript 5.x with strict mode enabled.
- ESM modules.
- `pnpm` for workspace and dependency management.

Recommended libraries:

- `commander` or `clipanion` for the command-line interface.
- `ink` for the interactive terminal UI.
- `zod` for typed configuration, events, artifacts, and tool payloads.
- Native `fetch`, `undici`, or provider SDKs for model transport.
- `@modelcontextprotocol/sdk` for MCP client and server integration.
- `execa` for subprocess execution, cancellation, and structured command results.
- `p-limit` or a small internal queue for controlled concurrency.
- `better-sqlite3` or a thin SQLite wrapper for local session, event, and usage persistence.
- `pino` for structured logging.
- `vitest` for tests.
- `eslint`, `prettier`, and `tsc --noEmit` for static quality checks.

Avoid a heavyweight distributed workflow framework in the MVP. Implement a small explicit state machine whose behavior can be tested and inspected locally.

## 5. High-Level Architecture

```text
Terminal UI
    |
Session Controller
    |
Intent + Risk Classifier
    |
Workflow Planner
    |
Lifecycle Orchestrator
    |-- Plan Agent
    |-- Design Agent
    |-- Develop Agent
    |-- Test Agent
    |-- Validate Agent
    |-- Deploy Agent
    `-- Document Agent
          |
          |-- Model Router -> Provider Adapters
          |-- Context Builder -> Repository Index + Artifact Store
          |-- Tool Gateway -> Local Tools + MCP Clients
          |-- Policy Engine -> Approval + Permissions
          `-- Usage Ledger -> Tokens + Cost + Latency
```

### Required Modules

```text
packages/shadow/src/
  cli/
  tui/
  config/
  orchestration/
  agents/
  models/
  context/
  tools/
  mcp/
  policies/
  artifacts/
  persistence/
  telemetry/
  scripts/
  prompts/
```

Keep provider APIs, MCP transport, orchestration, and terminal presentation behind separate interfaces.

## 6. Execution Model

Each user request becomes a durable `Run` containing one or more `StageRun` records.

### Run State Machine

```text
RECEIVED
  -> CLASSIFIED
  -> PLANNED
  -> EXECUTING
  -> TESTING
  -> VALIDATING
  -> AWAITING_APPROVAL (optional)
  -> DEPLOYING (optional)
  -> DOCUMENTING
  -> COMPLETED | FAILED | CANCELLED
```

The lifecycle is not automatically linear. The planner produces a stage graph. Examples:

- A typo fix may use `Develop -> Test -> Validate`.
- A new service may use all seven stages.
- A documentation-only request may use `Plan -> Document -> Validate`.
- Test or validation failure may return control to `Develop` with a compact failure artifact.

The orchestrator must enforce:

- Maximum stage retries.
- Maximum model calls per stage.
- Token and cost budgets.
- Cancellation propagation.
- Tool timeouts.
- Approval gates.
- No concurrent writes to the same files.

## 7. Agent Contract

All lifecycle agents implement the same interface:

```python
class Agent(Protocol):
    async def run(self, task: StageTask, context: StageContext) -> StageResult: ...
```

### StageTask

- Goal.
- Stage name.
- Inputs and artifact references.
- Constraints.
- Allowed tools.
- Write permissions.
- Acceptance criteria.
- Token and cost budgets.
- Deadline and retry count.

### StageResult

- Status.
- Concise summary.
- Structured decisions.
- Produced artifacts.
- File changes or patch reference.
- Tool-call records.
- Test or validation results.
- Open risks.
- Recommended next stage.
- Usage totals.

Do not pass entire chat transcripts between agents. Store large content once and pass artifact identifiers plus short summaries.

## 8. Lifecycle Agents

### Plan Agent

Responsibilities:

- Interpret the user request and repository constraints.
- Determine required lifecycle stages.
- Create acceptance criteria and a dependency graph.
- Identify unknowns, risks, and approval requirements.
- Assign an execution budget to each stage.
- Recommend model capability tiers rather than exact model names.

Frontier-model use is most valuable here for ambiguous, architectural, or cross-cutting tasks.

Deterministic helpers:

- Repository inventory.
- Language and framework detection.
- Dependency and manifest parsing.
- Git status and change-scope collection.
- Task complexity scoring from measurable repository signals.

Potential MCP use:

- Issue tracker or requirements retrieval.
- Documentation lookup.
- Repository hosting metadata.
- Dependency intelligence.

### Design Agent

Responsibilities:

- Convert the plan into interfaces, data models, module boundaries, and migration strategy.
- Identify compatibility and security implications.
- Produce design decisions in a compact structured format.

Frontier-model use is appropriate for novel architecture or high-risk refactoring. Routine feature design should use a balanced model.

Deterministic helpers:

- Dependency graph generation.
- Schema extraction.
- API specification validation.
- Architecture-rule checks.

Potential MCP use:

- API catalog.
- Design-system metadata.
- Schema registry.
- Architecture decision record store.

### Develop Agent

Responsibilities:

- Implement one bounded work unit at a time.
- Read only relevant files and interfaces.
- Produce patches rather than retransmitting complete files where practical.
- Run formatters and targeted static checks through deterministic tools.
- Stop and escalate when implementation contradicts the approved design.

Default to a balanced coding model. Escalate difficult debugging, unfamiliar languages, or broad refactors to the frontier tier.

Deterministic helpers:

- Formatting.
- Import sorting.
- Code generation from schemas.
- Safe symbol rename through language tooling.
- Dependency installation.
- Patch application.
- AST-based edits where supported.

Potential MCP use:

- Language server operations.
- Code search and indexing.
- Package registry lookup.
- Repository hosting operations.

### Test Agent

Responsibilities:

- Select or write tests from acceptance criteria.
- Send a structured execution request to Tests MCP.
- Interpret normalized failures.
- Return compact failure evidence to Develop.
- Expand test scope only when risk warrants it.

The Test Agent should not stream raw test logs into model context. Tests MCP stores complete logs and returns summaries, failing test identifiers, relevant stack frames, and artifact references.

Deterministic helpers:

- Test discovery.
- Changed-file-to-test mapping.

- Coverage extraction.
- Flaky-test retry policy.
- Snapshot comparison.

Potential MCP use:

- Tests MCP.
- Browser automation.
- Device or simulator lab.
- CI provider.
- Performance benchmark service.

### Validate Agent

Responsibilities:

- Compare the implementation and test evidence against acceptance criteria.
- Inspect the final diff for regressions, security risks, incomplete work, and unrequested changes.
- Require remediation or approve completion.
- Remain independent from the Develop Agent when budget permits.

Use a strong reasoning model for risky changes. Use a smaller model plus deterministic checks for narrow changes.

Deterministic helpers:

- Diff scope verification.
- Lint, type-check, and security scan result parsing.
- Secret detection.
- License checks.
- Artifact completeness checks.

Potential MCP use:

- Security scanning.
- Policy and compliance evaluation.
- Dependency vulnerability scanning.
- Code review service.

### Deploy Agent

Responsibilities:

- Generate and review a deployment plan.
- Require explicit user approval for external side effects.
- Execute deployment through a constrained MCP server or deterministic adapter.
- Verify health and support rollback.

Use a smaller model for known deployment procedures. Escalate only for novel failures or risky migrations.

Deterministic helpers:

- Build and package commands.
- Version calculation.
- Release artifact checksums.
- Environment readiness checks.
- Rollback scripts.

Potential MCP use:

- Git hosting.
- CI/CD platform.
- Cloud provider.
- Container registry.
- Hosting platform.
- Observability service.

### Document Agent

Responsibilities:

- Update documentation affected by actual changes.
- Generate concise change summaries, migration notes, and operational instructions.
- Avoid documenting features that were planned but not implemented.

This stage normally uses a low-cost model.

Deterministic helpers:

- CLI help extraction.
- API reference generation.
- Changelog formatting.
- Broken-link checks.
- Documentation build.

Potential MCP use:

- Documentation platform.
- Knowledge base.
- Repository hosting release notes.

## 9. Model Routing

Define capability tiers in configuration:

```yaml
models:
  frontier:
    provider: provider_a
    model: model-name
    max_output_tokens: 12000
  balanced:
    provider: provider_a
    model: model-name
    max_output_tokens: 6000
  economy:
    provider: provider_b
    model: model-name
    max_output_tokens: 3000
```

Map agents to tiers:

```yaml
agents:
  plan: frontier
  design: frontier
  develop: balanced
  test: economy
  validate: balanced
  deploy: economy
  document: economy
```

Routing inputs should include:

- Task ambiguity.
- Repository size.
- Number of affected modules.
- Security and deployment risk.
- Language familiarity.
- Previous stage failures.
- Remaining token and cost budget.
- Model tool support and context limit.

Escalation policy:

1. Begin at the configured tier.
2. Retry deterministic failures without another model call when possible.
3. On a reasoning failure, retry once with improved compact evidence.
4. Escalate one tier only when an explicit trigger is met.
5. Never escalate beyond the run budget without user approval.

Examples of escalation triggers:

- Two failed implementation attempts.
- Conflicting acceptance criteria.
- Cross-module API redesign.
- Security-sensitive code.
- Unexplained test regression.
- Destructive migration or deployment action.

## 10. Token-Conservation System

Token conservation must be enforced in code, not left to prompt wording.

### Context Selection

- Build a repository index using file metadata, symbols, imports, and concise summaries.
- Select files through lexical search, symbol relationships, and changed-file proximity.
- Load targeted line ranges before complete files.
- Exclude generated files, binaries, lockfiles, vendored code, and build output unless needed.
- Cache immutable file content by hash.
- Reuse summaries until the underlying hash changes.

### Artifact Compression

- Store full command output outside model context.
- Normalize diagnostics into structured records.
- Deduplicate repeated errors.
- Keep only relevant stack frames.
- Summarize large diffs by file and symbol before escalation.
- Pass references to complete logs for optional retrieval.

### Prompt Discipline

- Use a small stable system prompt per agent.
- Inject only stage-specific instructions.
- Request schema-constrained output.
- Set strict output limits.
- Do not ask models to narrate routine tool use.
- Do not resend information already persisted as structured state.

### Budgets

Support:

- Maximum input tokens per call.
- Maximum output tokens per call.
- Maximum tokens per stage.
- Maximum total tokens per run.
- Maximum estimated monetary cost per run.
- Reserved frontier-model budget.

Before each call, the router must estimate context size and reject, trim, summarize, or request approval when the call exceeds budget.

### Cache

Cache by model, prompt template version, tool definitions, selected artifact hashes, and request body. Never cache calls involving secrets or unstable external state unless explicitly marked safe.

## 11. Deterministic Action Runner

Implement deterministic work as TypeScript handlers first, and allow registered external commands only when the target repository requires its native toolchain. The registry must use versioned actions with machine-readable manifests:

```yaml
id: tests.vitest.changed
version: 1
handler: "@shadow/actions/tests/vitestChanged"
fallback_command: ["pnpm", "vitest", "run"]
inputs:
  - test_paths
timeout_seconds: 300
network: false
writes_workspace: false
output_schema: test_result_v1
```

The runner must:

- Use argument arrays rather than shell interpolation.
- Prefer in-process TypeScript handlers for Shadow-native analysis.
- Enforce timeouts and output-size limits.
- Capture stdout and stderr to artifact files.
- Return structured summaries.
- Declare network, filesystem, and workspace-write permissions.
- Reject unknown actions unless the user approves an ad hoc command.
- Record command, working directory, exit status, duration, and artifact hashes.

Models choose action IDs and typed inputs. They should not generate shell commands when a registered action already covers the operation.

Initial action categories:

- Repository inspection.
- Language and framework detection.
- Formatting and linting.
- Type checking.
- Test discovery and execution fallback.
- Coverage parsing.
- Build and packaging.
- Git diff and status summarization.
- Secret and dependency scanning.
- Documentation generation and link checking.

## 12. Tests MCP

Build Tests MCP as the first dedicated MCP server because test execution produces high-volume output with a stable structured interface.

### Tools

```text
discover_tests
run_tests
get_test_status
get_test_summary
get_failure_details
get_coverage_summary
cancel_test_run
```

### `run_tests` Request

```json
{
  "workspace_id": "...",
  "framework": "pytest",
  "selectors": ["tests/test_cli.py::test_start"],
  "changed_files": ["shadow/cli/main.py"],
  "environment_profile": "local-macos",
  "timeout_seconds": 300,
  "coverage": false,
  "max_retries": 1
}
```

### Summary Response

```json
{
  "run_id": "...",
  "status": "failed",
  "counts": {"passed": 18, "failed": 1, "skipped": 2},
  "failures": [
    {
      "test_id": "tests/test_cli.py::test_start",
      "category": "assertion",
      "message": "expected exit code 0, received 1",
      "relevant_frames": ["shadow/cli/main.py:42"],
      "log_artifact_id": "artifact_123"
    }
  ],
  "duration_ms": 4120
}
```

Tests MCP should own framework adapters, subprocess management, raw logs, truncation, and normalization. The Shadow orchestrator should own test selection strategy, acceptance criteria, retry decisions, and agent routing.

## 13. MCP Strategy

Create an internal MCP client abstraction that supports local stdio servers first. Add HTTP transport later.

Every MCP tool must declare:

- Input and output schema.
- Side-effect level.
- Required permissions.
- Timeout.
- Idempotency behavior.
- Expected output size.
- Whether user approval is required.

Classify tools as:

- `read_only`
- `workspace_write`
- `external_write`
- `destructive`

MCP adoption criteria:

- The operation is common across projects.
- Output is large and benefits from server-side normalization.
- The operation needs a stable integration boundary.
- Execution can be made more reliable than model-generated shell commands.
- The service can return concise structured evidence.

Do not create an MCP server for every command. Keep simple, local, low-output operations in the deterministic script runner.

## 14. Configuration

Configuration precedence:

```text
CLI flags > repository config > user config > built-in defaults
```

Files:

```text
~/.config/shadow/config.yaml
.shadow/config.yaml
.shadow/policy.yaml
```

Core configuration areas:

- Providers and model aliases.
- Per-agent model mapping.
- Token and cost budgets.
- Lifecycle stage enablement.
- MCP servers.
- Script registry.
- Approval policy.
- Workspace exclusions.
- Telemetry and retention.

Secrets must come from environment variables or the macOS Keychain, never repository configuration or logs.

## 15. CLI and Terminal Experience

Commands:

```text
shadow                       Start interactive mode in the current directory
shadow run "request"         Run a request non-interactively
shadow init                  Create repository configuration
shadow resume <run-id>       Resume an interrupted run
shadow status [run-id]       Show stage, budget, and pending approvals
shadow models                Show configured model aliases and agent mappings
shadow mcp list              Show MCP server health and capabilities
shadow config validate       Validate merged configuration
shadow doctor                Check local dependencies and credentials
shadow logs <run-id>         Inspect local run events
```

Interactive mode should show:

- Current stage and assigned model tier.
- Compact activity updates.
- Token and estimated cost usage.
- Files changed.
- Test and validation status.
- Approval prompts.
- Final summary and next actions.

Commands inside chat:

```text
/status
/plan
/diff
/budget
/approve
/reject
/cancel
/model <stage> <alias>
```

Do not stream internal chain-of-thought. Display concise decisions, actions, evidence, and failures.

## 16. Safety and Permissions

Default policies:

- Read access is limited to the active workspace plus explicitly allowed paths.
- Writes are limited to the active workspace.
- No destructive git operations.
- No deployment or external write without approval.
- No secret values in prompts, logs, or artifacts.
- No network access for deterministic scripts unless declared.
- New-project creation must resolve and display the target directory before writing.

Approval is required for:

- Deleting files.
- Writing outside the workspace.
- Installing global packages.
- Changing credentials or secrets.
- Force-pushing or rewriting history.
- Opening pull requests or publishing releases.
- Deploying to external environments.
- Running unregistered commands classified as risky.

## 17. Persistence and Observability

Use SQLite for metadata and content-addressed files for large artifacts.

Persist:

- Sessions and runs.
- Stage state and dependencies.
- User messages and concise assistant responses.
- Structured agent inputs and outputs.
- Model usage and estimated cost.
- Tool and MCP calls.
- Approvals.
- File hashes and patch artifacts.
- Test, validation, and deployment evidence.

Support JSONL event export. Telemetry must be local-only and opt-in for any remote reporting.

## 18. Repository Index

The MVP index should remain lightweight:

1. Walk tracked and relevant untracked files.
2. Apply ignore rules from Git and Shadow configuration.
3. Detect language and extract symbols with available parsers.
4. Record imports and basic symbol relationships.
5. Hash file content.
6. Create short model-generated summaries only for files that become relevant.
7. Invalidate records by hash after edits.

Start with SQLite full-text search plus lexical scoring. Add embeddings only after measurements show they improve file selection enough to justify cost and complexity.

## 19. Implementation Phases

### Phase 0: Specifications and Evaluation Fixtures

- Finalize typed schemas for runs, stages, artifacts, tools, usage, and approvals.
- Define three representative fixture repositories: small Python CLI, TypeScript application, and mixed-language repository.
- Define token, cost, latency, correctness, and intervention metrics.
- Create golden user tasks and expected acceptance criteria.

Exit criteria: schemas validate, fixture tasks are versioned, and benchmark reporting works.

### Phase 1: CLI and Single-Agent Vertical Slice

- Implement package layout and `shadow` entry point.
- Add interactive terminal chat.
- Add configuration loading and validation.
- Add one provider adapter.
- Add safe local filesystem and subprocess tools.
- Implement a single Develop agent that can make a bounded edit.
- Persist runs and events.

Exit criteria: `shadow` can complete and resume a simple repository edit with an auditable record.

### Phase 2: Lifecycle Orchestration

- Implement the state machine and stage graph.
- Add all seven agent contracts and prompt templates.
- Add structured artifacts between stages.
- Add stage skipping, retries, cancellation, and approval gates.
- Add per-agent model configuration.

Exit criteria: a feature request can move through a configurable multi-agent workflow without sharing full transcripts.

### Phase 3: Token Controls and Routing

- Add repository indexing and context selection.
- Add token estimation and budgets.
- Add usage ledger and estimated costs.
- Add capability-based routing and escalation.
- Add context caching, diagnostic normalization, and artifact references.

Exit criteria: benchmark reports prove per-stage and total budgets are enforced.

### Phase 4: Deterministic Runner and Tests MCP

- Implement the action manifest and runner.
- Move formatting, linting, static checks, and repository inspection into registered TypeScript actions.
- Build Tests MCP with TypeScript-first framework adapters, then add project-native adapters such as `pytest` where fixture repositories require them.
- Add log storage, normalization, cancellation, and compact failure responses.
- Keep a local fallback when Tests MCP is unavailable.

Exit criteria: raw test logs do not enter model context by default, and test workflows recover cleanly from server failure.

### Phase 5: Validation, Deployment, and Documentation

- Add independent validation policy.
- Add security and secret scanning adapters.
- Add deployment plan, approval, execution, health-check, and rollback contracts.
- Add documentation diffing and generation.
- Implement dry-run previews for external actions.

Exit criteria: risky actions require approval and produce verifiable evidence.

### Phase 6: Hardening and macOS Distribution

- Add crash recovery and corrupted-state handling.
- Add credential storage through macOS Keychain.
- Add installation, upgrade, and uninstall paths.
- Test on Intel and Apple Silicon where available; document the supported baseline.
- Profile memory, CPU, startup time, and long-running sessions.

Exit criteria: a clean macOS machine can install, configure, run, resume, and remove Shadow using documented commands.

## 20. Testing Strategy

### Unit Tests

- Configuration precedence and validation.
- Router decisions and escalation triggers.
- Token and cost budget enforcement.
- State transitions and retry limits.
- Context selection and cache invalidation.
- Permission classification.
- Output normalization.

### Integration Tests

- Provider adapters with recorded fixtures.
- MCP lifecycle and protocol failures.
- Script runner timeout and output limits.
- SQLite recovery and run resumption.
- Git-aware edit workflows.
- Approval gates.

### End-to-End Tests

- Modify a small existing repository.
- Create a new project.
- Recover from a failing test.
- Resume after interruption.
- Reach a token budget and request approval.
- Operate with Tests MCP unavailable.
- Reject a dangerous command.
- Complete a dry-run deployment.

### Evaluation Metrics

- Task success rate.
- Acceptance-criteria pass rate.
- Human corrections required.
- Input and output tokens by stage.
- Frontier-model token percentage.
- Total estimated model cost.
- Time to completion.
- Test and validation failure recovery rate.
- Irrelevant files loaded into context.
- Unnecessary stages invoked.

The key comparison is Shadow orchestration versus one frontier model performing the same tasks end to end.

## 21. Acceptance Criteria for MVP

- Running `shadow` opens an interactive agent in the current directory.
- The user can request repository changes or a new project.
- Every lifecycle stage can be enabled, skipped, or assigned a model alias.
- Shadow can reserve frontier-model usage for selected stages.
- Token budgets are enforced before model calls.
- Agents exchange structured artifacts rather than full transcripts.
- Deterministic scripts handle registered repetitive operations.
- Tests can be executed through Tests MCP with compact structured results.
- Shadow falls back safely when an optional MCP server is unavailable.
- External writes and risky actions require explicit approval.
- Runs are auditable and resumable.
- The full test suite passes on the supported 2021 MacBook environment.
- Benchmark results demonstrate lower frontier-model token usage than the single-model baseline without an unacceptable reduction in task success.

## 22. Required Design Decisions Before Coding

Record these as architecture decision records:

1. Exact Node.js, TypeScript, package manager, and distribution baseline for Intel versus Apple Silicon Macs.
2. Initial provider adapter and authentication mechanism.
3. Token estimation method for each provider.
4. Patch application and conflict-resolution strategy.
5. Repository indexing parser choices by language.
6. MCP protocol version and local server lifecycle.
7. Tests MCP framework support in the first release.
8. Default approval policy and risk taxonomy.
9. Artifact retention and cleanup policy.
10. Benchmark success threshold and acceptable quality tradeoff.

## 23. Guidance for the Implementing LLM

- Implement phases in order and keep each phase runnable.
- Do not hard-code model names into orchestration logic.
- Do not send an entire repository or full run history to a model.
- Do not parse structured configuration, source syntax, test reports, or model responses with fragile string splitting when a parser or schema is available.
- Do not let agents call providers or subprocesses directly; route them through the model router and tool gateway.
- Do not let MCP servers decide lifecycle policy.
- Do not add an abstraction unless it enforces a real boundary described in this plan.
- Add tests with every state transition, permission boundary, and budget rule.
- Measure token savings from the first vertical slice onward.
- Treat task quality and safety as constraints; token reduction alone is not success.
- End every implementation phase with working documentation, reproducible verification commands, and benchmark output.

## Current State Snapshot

> **Mandatory maintenance contract:** This is the repository's mutable handoff section, not a historical changelog. Every LLM that completes a meaningful implementation step in this repository must rewrite the snapshot below before its final response. Preserve this maintenance contract, replace stale statements instead of appending progress notes, record only capabilities verified in the repository, update the verification results, and leave the next implementer with an explicit account of remaining work and the highest-priority next step.

### Snapshot Metadata

- Last rewritten: 2026-09-04.
- Implementation shape: runnable cross-phase vertical slice. Phases 0 through 4 are substantially represented, Phase 5 is partially implemented, and Phase 6 has not started. This does not mean every exit criterion in the represented phases is complete.
- Runtime baseline: Node.js 22.11 or newer, TypeScript 5.x strict ESM, pnpm 10.15.0 workspace, macOS-first.
- Primary package: `packages/shadow`.
- Persistence: local SQLite metadata plus content-addressed artifact files under `.shadow`.

### Current Capabilities

#### CLI and Sessions

- `shadow` opens a readline-based interactive terminal session scoped to the current working directory.
- Implemented commands include `run`, `init`, `resume`, `status`, `models`, `actions list`, `mcp list`, `config validate`, `doctor`, `logs`, `approve`, `reject`, `cancel`, `benchmark observe`, and `benchmark report`.
- Interactive commands include status, plan, diff, budget, approval, rejection, cancellation, model/action inspection, and exit flows.
- Runs, stage tasks, stage attempts, events, approvals, usage, cancellation requests, and artifact references are durable and resumable through SQLite.
- Legacy JSON/JSONL run data has a one-time import path into SQLite.

#### Lifecycle Orchestration

- The explicit state machine supports Plan, Design, Develop, Test, Validate, Deploy, and Document stage runs, including stage skipping, bounded retries, cancellation propagation, model-call limits, approval pauses, and resume.
- All seven lifecycle stages have concrete agents; no lifecycle stage remains a placeholder.
- Plan performs deterministic repository inspection and records a compact plan result.
- Design uses schema-constrained model output to produce interfaces, boundaries, and decisions.
- Develop selects bounded repository context, requests a unified diff, checks scope and selected-file hashes, and applies approved workspace changes through the tool gateway.
- Test selects tests from changed files and indexed relationships, prefers Tests MCP, and falls back to a registered local action.
- Validate runs Git scope inspection, type checking, secret scanning, and dependency-integrity scanning.
- Deploy uses configured deterministic command arrays with a dry-run preview, explicit external-action approval, health verification, durable receipts, duplicate-deploy prevention on resume, and separately approved rollback.
- Document uses verified implementation evidence and may patch only selected existing documentation files.
- Stage inputs use artifact references and compact structured results rather than complete chat transcripts.

#### Models, Context, and Budgets

- Provider calls are behind a generic adapter interface with an OpenAI-compatible implementation.
- Agents route through configurable `frontier`, `balanced`, and `economy` capability tiers rather than hard-coded model names.
- Model routing performs preflight input, output, total-token, estimated-cost, stage, run, and reserved-frontier budget checks.
- Repository context uses Git-aware discovery, Shadow exclusions, bounded reads, content hashes, SQLite FTS5 lexical search, import proximity, and symbol extraction.
- TypeScript and JavaScript symbols use the TypeScript compiler API; Python metadata uses a batched standard-library AST helper.
- Selected context is hash-verified before patch application and likely credentials are redacted before model calls.
- Durable index entries are invalidated when file hashes change or files disappear.

#### Tools, Safety, and Testing

- The deterministic runner validates versioned action manifests, uses argument arrays without shell interpolation, constrains working directories, limits runtime and output, propagates cancellation, and stores full bounded output as artifacts.
- Registered actions currently cover repository inspection, context selection and verification, Git status, patch checking and application, local test and type-check execution, test selection, deployment and rollback, secret scanning, and dependency-integrity scanning.
- Policy classes are `read_only`, `workspace_write`, `external_write`, and `destructive`; deployment and external effects require approval by default.
- Deployment profiles are opt-in. Credentials are named in configuration but read from the environment, and known credential values are redacted from deployment logs before persistence.
- Secret scanning reports only rule, path, line, and severity. High-confidence provider tokens and private keys fail validation; warning-level assignments remain visible risks.
- Dependency scanning currently parses `package.json` and checks malformed data, unbounded versions, direct remote sources, and lockfile coverage without network access. It explicitly reports that vulnerability advisories were not checked.
- Tests MCP is a local stdio server with `discover_tests`, `run_tests`, `get_test_status`, `get_test_summary`, `get_failure_details`, `get_coverage_summary`, and `cancel_test_run` tools.
- Tests MCP includes Vitest and pytest adapters, bounded raw-log artifacts, normalized failures, polling, cancellation, and local fallback behavior.

#### Benchmarks and Documentation

- Versioned benchmark fixtures exist for a small Python CLI, a TypeScript application, and a mixed Python/TypeScript service.
- Fixture schemas cover requests, relevant files, acceptance criteria, permitted effects, expected evidence, and safety assertions.
- `benchmark observe` derives Shadow token use by tier, total usage, cost, latency, approvals, retries, stage count, test recovery, and irrelevant context from a terminal durable run and verified artifacts. Acceptance results remain explicit evaluator inputs.
- `benchmark report` requires exactly paired baseline and Shadow observations and enforces ADR 0010's frontier-token reduction, quality-retention, intervention, and dangerous-action rejection thresholds.
- Architecture decisions 0001 through 0013 document the current platform, provider, persistence, policy, token, patch, index, MCP, retention, benchmark, SQLite, deployment, and local-security choices.

### Verified State

- `../../node_modules/.bin/vitest run` from `packages/shadow`: 21 test files and 68 tests passed.
- `../../node_modules/.bin/tsc --noEmit -p tsconfig.json` from `packages/shadow`: passed.
- `../../node_modules/.bin/tsc -p tsconfig.build.json` from `packages/shadow`: passed.
- Built CLI benchmark command help and sample benchmark report: passed.
- Repository self-scan: no high-confidence secrets; one warning-level credential assignment in an intentional test fixture; no dependency-integrity findings.

### Still Missing

#### Product-Critical Gaps

- New-project creation is not implemented end to end.
- Develop and Document are limited to edits of selected existing text files. New files, deletions, renames, binary changes, and patch conflict remediation are not supported.
- Test or validation failure does not yet route a compact failure artifact back into a bounded Develop remediation loop; current retry behavior remains stage-local.
- The interactive terminal is a basic readline loop, not the richer Ink interface described in the product plan.
- Model aliases in generated defaults are placeholders and require user configuration before real model-backed work.

#### Routing and Token Controls

- Only the OpenAI-compatible provider transport is implemented; additional provider adapters and provider-specific token estimators are missing.
- Escalation policy is not yet fully capability-driven across ambiguity, risk, repeated reasoning failures, and remaining reserved budget.
- Model-response caching keyed by prompt version, tool definitions, and artifact hashes is not implemented.
- Relevant-file summaries are not model-generated or cached, and there is no measured comparison proving whether embeddings would help.

#### Validation and Integrations

- Dependency scanning has no OSV, package-manager audit, or other advisory-backed vulnerability data.
- License checking, broader language-specific dependency parsing, and dedicated static/security scanner adapters are missing.
- Validate is deterministic and does not yet perform an independent model-based final diff review for high-risk changes.
- Formatting, linting, import sorting, packaging, documentation link checking, and release checksum actions are not yet registered as dedicated deterministic actions.
- MCP supports local stdio only. HTTP transport, non-test MCP integrations, capability metadata enforcement, and broader server lifecycle management remain deferred.

#### Deployment and Distribution

- Deployment currently trusts locally configured command arrays; cloud, CI/CD, hosting, health-observability, and rollback MCP adapters are not implemented.
- macOS Keychain credential storage is not implemented; credentials currently come from environment variables.
- There is no finished macOS installer, signed/notarized distribution, upgrade/uninstall flow, or Intel and Apple Silicon compatibility matrix.
- Crash and corrupted-state recovery need broader fault-injection coverage and operator repair tooling.

#### Evaluation Gaps

- There is no automated benchmark executor that provisions clean fixture snapshots, invokes both Shadow and the single-frontier baseline, evaluates acceptance criteria, and assembles paired observations.
- No real baseline-versus-Shadow benchmark results have been checked in, so the required frontier-token savings have not yet been demonstrated.
- End-to-end coverage is still missing for new-project creation, compact failure feedback to Develop, token-budget approval, Tests MCP outage during an active run, dangerous ad hoc command rejection, and installation on a clean Mac.

### Highest-Priority Next Step

Implement the automated benchmark executor before broadening the architecture further. It should copy each versioned fixture to an isolated workspace, run selected golden tasks through Shadow and a configured single-frontier baseline, collect durable observations without leaking full logs into model context, evaluate deterministic acceptance evidence where possible, and emit a paired report artifact. This will expose which remaining routing, context, and remediation work actually improves cost without hiding quality regressions.
