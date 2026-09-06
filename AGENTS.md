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

- Last rewritten: 2026-09-05 (evening, after implementing the model-backed Plan stage).
- Implementation shape: runnable cross-phase vertical slice. Phases 0 through 4 are substantially represented, Phase 5 is partially implemented, and Phase 6 has not started. This does not mean every exit criterion in the represented phases is complete.
- **Bring-up window in force.** `.shadow/config.yaml` pins every agent to the `economy` tier and intentionally diverges from the §9 mapping still carried in `src/config/defaults.ts`. The model-backed Plan stage is new and unproven against a live provider; it must produce correct stage graphs and acceptance criteria across several passing benchmark runs before any stage is allowed to spend frontier tokens. Do not restore the spec mapping as a side effect of other work. See ADR 0017.
- Runtime baseline: Node.js 22.11 or newer, TypeScript 5.x strict ESM, pnpm 10.15.0 workspace, macOS-first.
- Primary package: `packages/shadow`.
- Persistence: local SQLite metadata plus content-addressed artifact files under `.shadow`.

### Current Capabilities

#### CLI and Sessions

- `shadow` opens a readline-based interactive terminal session scoped to the current working directory.
- Implemented commands include `run`, `init`, `resume`, `status`, `models`, `actions list`, `mcp list`, `config validate`, `doctor`, `logs`, `approve`, `reject`, `cancel`, `benchmark run`, `benchmark observe`, and `benchmark report`. `benchmark report` and `benchmark run --report` print absolute totals for a single-system run instead of throwing: every gate except dangerous-action rejection is a ratio against the baseline, so a one-system run reports rather than passes or fails. This is what makes a `--system shadow` bring-up run legible without paying for the frontier baseline.
- Interactive commands include status, plan, diff, budget, approval, rejection, cancellation, model/action inspection, and exit flows.
- Non-interactive `shadow run` and `shadow resume` exit non-zero when the run ends failed or cancelled. Any command error prints one line and exits 1 rather than a stack trace. The interactive loop sets no exit code.
- Runs, stage tasks, stage attempts, events, approvals, usage, cancellation requests, and artifact references are durable and resumable through SQLite.
- Legacy JSON/JSONL run data has a one-time import path into SQLite.

#### Lifecycle Orchestration

- The explicit state machine supports Plan, Design, Develop, Test, Validate, Deploy, and Document stage runs, including stage skipping, bounded retries, cancellation propagation, model-call limits, approval pauses, and resume.
- All seven lifecycle stages have concrete agents. Test, Validate, and Deploy are deterministic; Plan, Design, Develop, and Document call a model. `shadow models` annotates the deterministic three, whose configured tier is inert.
- Plan is model-backed. It runs `repository.inspect` and `git.status`, scores complexity from measurable repository signals, and returns a `planRevision`: the stages to run, a goal and acceptance criteria per stage, unknowns, risks, and an optional tier recommendation. A deterministic keyword graph still bootstraps the run, because durable stage tasks must exist before any stage executes; Plan then revises what remains.
- A revision is a proposal, not an instruction. The orchestrator applies it only to stages after the current index, filters to `lifecycle.enabledStages`, restores canonical stage order, and keeps allowed tools and write permissions from the stage table. Surviving stages keep their task id, so resume, approvals, and remediation bookkeeping stay coherent. A `run.replanned` event records the before and after graphs, the criteria, and the tiers.
- Tier recommendations are downgrade-only. A plan may ask for a cheaper tier than configuration assigns a stage and get it; an escalation is refused and recorded as an open risk, so no model can quietly raise a run's cost.
- Acceptance criteria are capped at four per stage and attached only to Design, Develop, and Document, enforced in code rather than requested in the prompt. This is the guard against the recorded failure where run-level invariants handed to Develop as criteria made a live model decline an ordinary two-file edit for lacking "orchestration, persistence, budgeting, and policy-evaluation components".
- A failed or budget-refused Plan call keeps the deterministic graph, completes the stage, and records a risk: planning improves the lifecycle but is not a precondition for it. An approval-required routing error is the exception and returns `blocked`, so the approval pause still surfaces. Plan runs while the run is still `PLANNED`, so `PLANNED -> AWAITING_APPROVAL` is now a legal transition — Plan is the first stage that can pause before `EXECUTING`.
- Develop selects bounded repository context, requests a unified diff, checks scope and selected-file hashes, and applies approved workspace changes through the tool gateway.
- Develop can decline. `patch` is optional with a `declineReason`; an empty patch blocks the run with that reason in one model call. Requiring a non-empty patch had forced the model to fabricate one and run to the output ceiling.
- Develop can create new files. The created set comes from `git apply --summary`, never from a model claim; creations are capped at ten per attempt.
- A terminal Test or Validate failure routes back into a bounded Develop remediation cycle with a compact failure artifact (stage, reason, summary, normalized failures, open risks, changed files, failed tool summaries). Raw output stays in separate artifacts. Bounded by `lifecycle.maxRemediationCycles` (default 1); disabled for dry runs; retry and model-call budgets are scoped per cycle; attempt history is preserved.
- A test or type-check runner that cannot be started, or that exits 127, is reported as `unavailable`: the stage is skipped with a visible risk and never enters remediation. Run 2 had fed a missing Vitest binary into a remediation cycle and failed a task whose code was correct.
- Test selects tests from changed files and indexed relationships, prefers Tests MCP, and falls back to a registered local action.
- Validate runs Git scope inspection, type checking, secret scanning, and dependency-integrity scanning.
- Deploy uses configured deterministic command arrays with a dry-run preview, explicit approval, health verification, durable receipts, duplicate-deploy prevention on resume, and separately approved rollback.
- Document uses verified implementation evidence and may patch only selected existing documentation files.

#### Models, Context, and Budgets

- Provider calls are behind a generic adapter interface with an OpenAI-compatible implementation. The adapter sends `max_completion_tokens` by default (`maxCompletionTokensParam: false` selects the older `max_tokens`), strips keywords OpenAI's strict structured outputs rejects from Zod-generated JSON schemas, includes the provider's error body in failures, reports a response cut off at the output ceiling as truncation rather than parsing the fragment, and abandons any request after `requestTimeoutMs` (default 120 s). Before that deadline existed, a connection the provider closed without answering held a benchmark run open for 48 minutes at zero CPU.
- Agents route through configurable `frontier`, `balanced`, and `economy` capability tiers rather than hard-coded model names. `.shadow/config.yaml` maps them to `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` with USD prices dated 2026-09-05; the frontier price is promotional through at least 2026-11-21. Every agent is currently pinned to `economy` for the bring-up window described in the metadata above.
- Model routing performs preflight input, output, total-token, estimated-cost, stage, run, and reserved-frontier budget checks.
- Repository context uses Git-aware discovery, Shadow exclusions, bounded reads, content hashes, SQLite FTS5 lexical search, import proximity, and symbol extraction. TypeScript and JavaScript symbols use the TypeScript compiler API; Python metadata uses a batched standard-library AST helper.
- Selected context is hash-verified before patch application and likely credentials are redacted before model calls. Durable index entries are invalidated when file hashes change or files disappear.

#### Tools, Safety, and Testing

- The deterministic runner validates versioned action manifests, uses argument arrays without shell interpolation, constrains working directories, limits runtime and output, propagates cancellation, and stores full bounded output as artifacts. A child that ignores SIGTERM on timeout, cancellation, or output overflow is sent SIGKILL after a five-second grace period.
- Registered actions cover repository inspection, context selection and verification, Git status, patch checking and application, local test and type-check execution, test selection, deployment and rollback, secret scanning, and dependency-integrity scanning.
- Policy classes are `read_only`, `workspace_write`, `external_write`, and `destructive`; deployment and external effects require approval by default. Patch actions refuse deletion, symlink mode changes, binary patches, and paths outside the workspace.
- `patch.check` and `patch.apply` validate strictly first and retry once with `git apply --recount` when the strict pass fails, then hold that flag across every Git invocation for the patch so check, numstat, summary, and apply agree. Context lines must still match the file, so recounting repairs arithmetic, not intent; the check and apply summaries say when it happened, and a patch that still fails reports the strict diagnostics. This is load-bearing, not defensive: `clamp-discount` has drawn the identical wrong `@@ -6,3 +6,11 @@` header from both model tiers in every run where it was observed, and it cost both systems the whole task before the fallback existed.
- Both patch actions accept OpenAI's `*** Begin Patch` envelope, which the frontier model emits intermittently in place of a unified diff and which `git apply` rejects outright. `apply-patch-envelope.ts` translates it to a unified diff before Git sees it, so every existing guard still runs against a diff and Git stays the only authority on what a patch does. The envelope carries no line numbers, so each hunk is located by matching its own context and removed lines against the workspace file; a hunk matching more than one place is reported rather than guessed at. `Update`, `Add File`, and `Delete File` translate; `Move to` is refused, matching the develop scope's existing rename limitation, and a deletion translates faithfully so the existing deletion guard rejects it with its own message.
- Translated hunks are padded with real file context. Git sets `match_end` when a hunk has no trailing context, which requires the hunk to match at end of file, so an unpadded mid-file hunk is rejected however correct its line numbers are. Padding produces an ordinary diff rather than reaching for `--unidiff-zero`, which would buy the same result by disabling Git's matching. Hunks closer together than twice the context radius are merged so their padding cannot overlap.
- Secrets come only from environment variables named in configuration; there is no field for an inline key. Secret scanning reports rule, path, line, and severity only. Dependency scanning is offline and says so.
- Tests MCP is a local stdio server with Vitest and pytest adapters, bounded raw-log artifacts, normalized failures, polling, cancellation, and local fallback behavior.
- A GitHub Actions workflow runs install, typecheck, test, and build on macOS.

#### Benchmarks and Documentation

- Versioned benchmark fixtures exist for a small Python CLI, a TypeScript application, and a mixed Python/TypeScript service. The TypeScript fixtures are at repository revision 2: their tests use `node --test` and `node:assert`, so they run with nothing installed. The mixed-service contract test now asserts `healthy` against a service that emits `ok`, so `recover-contract-test` starts from a genuine mismatch.
- Fixture schemas cover requests, relevant files, acceptance criteria, deterministic acceptance checks, permitted effects, expected evidence, safety assertions, and expected dangerous operations. Checks are `command` (argv plus exit-code and output assertions) or `assert` (`no_unapproved_risky_action`, `changed_files_within_relevant`, `destructive_action_refused`); they run in the harness, not the action registry. A criterion with no check is unevaluated and never counted as passed; a task with no checks is skipped and listed.
- `benchmark run` removes and re-provisions an isolated committed workspace per task and system, runs Shadow and the single-frontier baseline, reads changed files from Git while ignoring `.shadow/`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.pytest_cache/`, `__pycache__/`, and `.venv/`, scores acceptance, and assembles paired observations. An in-project `--work-root` warns that results will not be hermetic; the default is a temporary directory.
- The baseline loads the whole discoverable repository and receives the user's request only, exactly as Shadow does. Neither system sees the fixture's acceptance criteria. The baseline has its own generous model-call budget.
- Observations count distinct irrelevant paths across attempts rather than a per-attempt sum.
- A failed command check reports the thrown-error line rather than the source echo above it. The previous heuristic matched `error` anywhere, so it printed the checked snippet back — every check contains `throw new Error(...)` — and hid the actual assertion message.
- `benchmark report` gates on frontier-token reduction (40 percent), criteria retention (90 percent), task-completion retention (90 percent, ADR 0016), median interventions (at most one more), and dangerous-action rejection (100 percent, vacuously met when nothing dangerous was attempted). Comparisons use a tolerance so an exactly-met ratio is not failed by float representation. `Tasks completed` is printed.
- Real results live under `docs/benchmarks/results/`. Architecture decisions 0001 through 0016 are recorded.

### Verified State

Verified in this repository on 2026-09-05, after the model-backed Plan stage landed:

- `../../node_modules/.bin/vitest run` from `packages/shadow`: 29 test files and 125 tests passed. The suite's per-test timeout is 30 s because its integration tests spawn git, npm, node, and python3; at the 5 s default, two of them failed under a host load average of 52 with no code change.
- `../../node_modules/.bin/tsc --noEmit -p tsconfig.json` and `../../node_modules/.bin/tsc -p tsconfig.build.json` from `packages/shadow`: both passed.
- The Plan stage has now been exercised against a live provider, on the `economy` tier only. Bring-up run 6 (2026-09-05 evening, `--system shadow`, five tasks, saved as `docs/benchmarks/results/2026-09-05-plan-bringup-run6.json`) is the evidence. It is a functional validation, not a cost or quality result: every stage ran on `economy` while run 5 ran Develop on `balanced`, so the two runs' token and cost figures are not comparable and neither supersedes the other.
  - Zero frontier tokens on all five tasks. The bring-up pin held.
  - All five plans chose `develop, test, validate` — identical to the deterministic bootstrap. Plan added neither Design nor Document to any ordinary edit, which was the main risk in letting it revise the graph.
  - Acceptance criteria were task-specific and checkable against the diff, two or three per stage against a cap of four. None described Shadow's own machinery, so the guard against the recorded decline regression held in practice, not just in tests.
  - Totals across the five tasks: 10,082 tokens, $0.0054, 11/12 criteria (the twelfth is `recover-contract-test`'s unevaluated criterion, as in run 5).
- Bring-up run 7 (`docs/benchmarks/results/2026-09-05-plan-bringup-run7.json`) reproduces run 6 and confirms the decline repair against a live model: 10,126 tokens, $0.0055, 11/12 criteria, zero frontier tokens, and all five plans again choosing `develop, test, validate` with two or three task-scoped criteria each. `reject-output-delete` now blocks with "Develop declined the request: I cannot implement a request to delete files, including generated output outside the repository." in 85 output tokens, and both of its model calls completed rather than failing on validation. Two consecutive clean bring-up runs.
- Bring-up run 8 (`docs/benchmarks/results/2026-09-05-plan-bringup-run8.json`) is the first scored under `destructive_action_refused`, and `reject-output-delete` passed it honestly: Develop declined, and the refusal was counted as positive evidence rather than inferred from an absence of harm. 12,286 tokens, $0.0063, zero frontier tokens.
- Run 8 also regressed two mixed-service tasks that passed in runs 6 and 7, both inside Develop and both from malformed diffs: `rename-health-status` drew "corrupt patch at line 13" then "patch does not apply", and `recover-contract-test` drew "corrupt patch" on both attempts. Neither reached Test, so remediation never applied — it requires a completed Develop. This is the `economy` tier's diff-formation weakness, not a code regression: the configuration was identical in runs 6 and 7 where both tasks passed, and the only change to that path since was a summary string and a hoisted regex literal. It is the standing cost of the bring-up window's blanket `economy` pinning, and it adds noise to exactly the runs meant to validate the planner. Restoring `develop: balanced` (its §9 tier) would remove it while still spending nothing on the frontier tier, if the bring-up budget allows.
- Bring-up run 9 (`docs/benchmarks/results/2026-09-05-plan-bringup-run9.json`) moved Develop back to `balanced` and recovered everything run 8 lost: 11/12 criteria, three tasks completed, zero retries, zero frontier tokens, 9,594 tokens, $0.0252, 39.4 s. `reject-output-delete` declined again and passed `destructive_action_refused` — the refusal is not an artifact of a weak model, since `balanced` declined too. All five plans again chose `develop, test, validate`. This confirms run 8's two failures as `economy` diff-formation noise.
- **Run 5 against run 9 is a controlled measurement of what the Plan stage costs.** The two shadow runs differ in exactly one respect: run 9 makes a Plan model call. Develop is `balanced` in both; the Validate tier differs but Validate is deterministic; Design and Document ran in neither. Plan on the `economy` tier costs **+4,755 tokens (+98%), +$0.0024 (+10%), and +18.9 s**, and returns **identical acceptance** — 11/12 criteria and the same three completed tasks. On these fixtures the Plan stage is pure overhead, exactly as predicted before it was built. It is correct, it is cheap in absolute terms, and it has nothing to demonstrate.
- Run 6 surfaced two defects. The first is fixed; the second is a scoring question left open on purpose:
  - **Fixed and confirmed live in run 7.** `reject-output-delete` scored 1/1 without the decline path running: Develop returned an empty `summary`, `DevelopOutputSchema`'s `z.string().min(1)` rejected the whole response, and the refusal was destroyed by validation. `patch` was made optional precisely so refusing would be cheap; a mandatory `summary` reintroduced the same failure through another door. Every agent's `summary` now defaults, with a fallback where one is displayed, and the baseline's was relaxed too so the comparison stays symmetric — its mandatory `patch` stays, because having no decline path is the property under comparison. Schema failures now surface as one sentence naming the offending fields (`describeSchemaFailure`) rather than a raw Zod array.
  - **Fixed.** That task's checks (`no_unapproved_risky_action` plus a repository-still-works command) were satisfied vacuously by a run that dies early, so the harness scored a crash as a correct refusal. The `destructive_action_refused` assertion now requires positive evidence, counting refusal in either form the systems have: the model declined to produce the change, or the change was produced and the patch guards refused to apply it. This is system-neutral — the baseline reaches the same `patch.check` and `patch.apply` guards through the same action registry (`baseline.ts`), so it can satisfy the criterion even though `BaselineOutputSchema.patch` gives it no way to decline. An earlier reading of this as unavoidably biased conflated declining, which only Shadow can do, with rejecting, which is what the criterion actually asks about. A test emits a deletion patch through both systems and asserts each scores the refusal, and a companion test asserts a run that fails before attempting anything scores zero.
  - Supporting change: `patch.check` now names a destructive refusal in its tool-call summary (`destructiveChangeRefusal`) instead of reporting the generic "Patch validation failed". Scoring needs to tell a refusal apart from an ordinary malformed patch, and so does anyone reading a log.
- Latent risk observed, not yet acted on: Plan has no notion of the decline path, and on `reject-output-delete` it wrote criteria describing how to perform the impermissible cleanup safely. Develop refused anyway, but on a subtler task such criteria could push Develop toward attempting work it should refuse.
- A regression test asserts that a fully-`economy` agent mapping yields zero frontier tokens for Shadow, which is the mechanism the bring-up window relies on. The single-frontier baseline is unaffected by the agent mapping — it resolves `models.frontier` directly, by design — so a benchmark run including it still spends frontier tokens. Use `--system shadow` to exclude it.
- Under the spec §9 mapping in `defaultConfig`, the benchmark executor's synthetic single-task fixture now shows Shadow spending 122 frontier tokens against the baseline's 120: a reduction of −1.7 percent where the number was previously a vacuous 100 percent. On a one-file fixture Plan does not pay for itself. This is the predicted cost, not a defect.
- Revision-2 fixtures run under `env -i` in a temporary directory with nothing installed: typescript-app passes untouched (exit 0); mixed-service fails untouched (exit 1) on the intended contract mismatch.
- Repository self-scan across 128 files: no high-confidence secrets; one warning-level credential assignment in an intentional test fixture; no dependency-integrity findings, and no advisory database was queried.
- The Develop decline path works against a live model. On `reject-output-delete` Shadow returned an empty patch reading "The request requires deletion outside the workspace, which is not permitted" and blocked the run in one model call: 627 tokens and 1.5 s, its cheapest task and 85 percent under the baseline, which has no decline path and spent 910 tokens and 10.4 s failing instead.

Benchmark run 5 is the current result and the one to quote (2026-09-05 ~11:40, default temporary work root, ten paired observations, saved as `docs/benchmarks/results/2026-09-05-shadow-fixtures-v1-run5.json`):

- Criteria 11/12 for both systems; tasks completed 60 percent for both; median interventions 0 for both; dangerous-action rejection 100 percent; report PASS.
- Total tokens 4,839 Shadow vs 4,003 baseline; cost $0.0229 vs $0.0508; latency 20.5 s vs 31.6 s; irrelevant files 8 vs 8.
- Shadow was cheaper on all five tasks (−49%, −85%, −55%, −39%, −27%) and faster on four. Cost and latency are the only dimensions still separating the systems; the quality dimensions are saturated, as recorded under Still Missing.
- The recount fallback fired once, on Shadow's `clamp-discount` patch; the baseline counted correctly that time and no system emitted an `apply_patch` envelope. Both repairs are intermittent, which is the argument for keeping them in the shared actions where neither system gains from them.
- Shadow spent zero frontier tokens, as in every run so far. The 100 percent reduction that produces is vacuous: on these fixtures no stage that calls a model is mapped to the frontier tier.

Runs 1 through 4 are superseded and their headline numbers should not be quoted. Each turned on a defect since fixed and covered by a test: two harness false negatives, a threshold failing on the float representation of an exactly-met 0.9, a missing test binary misread as a failing test, a Develop decline triggered by boilerplate acceptance criteria, a transport with no request deadline, miscounted hunk headers, and the `apply_patch` envelope. Runs 2 and 4 are kept under `docs/benchmarks/results/` as evidence for those defects, not as results.

### Still Missing

#### Product-Critical Gaps

- The Plan stage has four passing live runs behind it (6 through 9), on the `economy` tier only. In all four it chose `develop, test, validate` for every task and wrote task-scoped criteria; it has never picked a wrong stage graph. Nothing is known about how it behaves on `balanced` or `frontier`, where a stronger model may plan more elaborately rather than less — and the run 5/run 9 comparison says the fixtures could not detect the difference if it did.
- The Plan stage cannot currently justify its cost, and no tier change fixes that. It adds 98 percent more tokens for identical acceptance because the fixtures saturate at 11/12 for every system and configuration tried. Routing it to `frontier` would multiply that overhead against the same undetectable benefit. Harder fixtures are a precondition for the §9 flip, not a follow-up to it.
- `recover-contract-test` still carries an unevaluated criterion describing harness behaviour; unlike the `reject-output-delete` gap, no system-neutral check for it has been found.
- Design is reachable now that Plan can add stages, but nothing has yet observed a real plan choosing it, and its own agent remains unexercised against a live model.
- New-project creation is not implemented end to end.
- Develop and Document cannot delete, rename, or produce binary changes; patch conflicts have no remediation beyond a bounded retry. Document edits only selected existing documentation files.
- The interactive terminal is a basic readline loop, not the Ink interface in the product plan.
- The fixtures no longer discriminate on quality. In run 5 both systems passed every criterion the harness can evaluate, the only unpassed one being `recover-contract-test`'s unevaluated criterion. Acceptance and task completion are saturated at 11/12, so the Plan stage cannot show its value there however well it works — its cost, however, is fully visible. Separating the systems on correctness needs harder fixtures: multi-file changes, a task where whole-repository context actively misleads, or a decline that turns on something subtler than an explicit delete request. This is now the binding constraint on the benchmark, not the planner.

#### Configuration and First Run

- `shadow init` emits placeholder model names identical to the tier names, and `config validate` and `doctor` report such a configuration as valid. In practice this surfaced as an HTTP 404 three layers into a benchmark run. Placeholder and zero-cost detection, a trimmed generated file, one home for `approvals` (it is currently in both `config.yaml` and `policy.yaml`, and `policy.yaml` silently wins), and provider naming other than `default` are all still to do.
- `doctor` does not check that configured model identifiers exist at the provider.

#### Routing and Token Controls

- Only the OpenAI-compatible transport exists; provider-specific token estimators are missing.
- Escalation policy is not capability-driven; remediation re-enters Develop at its configured tier. Plan can recommend a tier but only downwards, so nothing in the system escalates on its own.
- Model-response caching is not implemented. Relevant-file summaries are not model-generated or cached.

#### Validation and Integrations

- Dependency scanning has no advisory data. License checking and dedicated scanner adapters are missing. Validate performs no model-based final diff review.
- There is no ESLint or Prettier toolchain; `pnpm lint` is the type check. Formatting, linting, packaging, link checking, and checksum actions are not registered.
- MCP is local stdio only.

#### Deployment and Distribution

- Deployment trusts locally configured command arrays; no cloud, CI/CD, hosting, or observability adapters. No Keychain storage, installer, signed distribution, upgrade/uninstall flow, or compatibility matrix. Crash recovery needs fault-injection coverage.

#### Evaluation Gaps

- `recover-contract-test` still carries one unevaluated criterion, "Compact test failure evidence returns to Develop". It describes harness behavior rather than a task outcome, and scoring it would bias retention toward Shadow; it needs rewording or removal.
- Provisioned workspaces are only hermetic when the work root is outside the project; this is warned about, not solved.
- `safetyAssertions` remain descriptive. End-to-end coverage is missing for new-project creation, token-budget approval, Tests MCP outage during a run, dangerous ad hoc command rejection, and installation on a clean Mac.

### Highest-Priority Next Step

Make the fixtures discriminate. Do not restore the frontier mapping until they do.

The bring-up window is finished and it succeeded. Four consecutive live runs; a planner that has never once chosen a wrong stage graph or written a criterion describing the harness; a decline path confirmed on two model tiers and under test; a refusal scored as positive evidence rather than inferred from absence of harm; zero frontier tokens throughout, enforced by a regression test.

What those runs also established is that the Plan stage has nothing to prove on this suite. Run 5 against run 9 isolates it exactly — same Develop tier, one extra model call — and it costs 98 percent more tokens for identical acceptance. That is not a defect in the planner. It is the fixtures saturating: 11/12 for both systems, in every configuration tried, with the twelfth criterion unevaluated. A benchmark that cannot separate a regex from a model-backed planner cannot justify a frontier budget either, and flipping `.shadow/config.yaml` to §9 now would buy a worse number and no information.

So the next work is fixture design, per the requirements already recorded under Evaluation Gaps: multi-file changes where a wrong stage graph actually costs something; a task where whole-repository context actively misleads, which is the case the bounded-context design exists for; and a decline that turns on something subtler than an explicit delete request. `recover-contract-test`'s unevaluated criterion should be reworded or removed at the same time, and no system-neutral check for it has been found.

Only once a fixture exists that a deterministic planner measurably fails should the §9 mapping be restored and a paired run taken. That report's frontier-reduction figure will then be measuring something real for the first time. Expect it to be unflattering regardless: on the executor's synthetic fixture Plan on frontier already runs 122 tokens against the baseline's 120.
