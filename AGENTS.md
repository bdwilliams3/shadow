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

- Last rewritten: 2026-09-05 (evening), after the model-backed Plan stage, Git-source fixtures, and the first real-repository benchmark run.
- Implementation shape: runnable cross-phase vertical slice. Phases 0 through 4 are substantially represented, Phase 5 is partially implemented, and Phase 6 has not started. This does not mean every exit criterion in the represented phases is complete.
- The tier table in `.shadow/config.yaml` is the operator's knob: each of `frontier`, `balanced`, and `economy` names a model, an output ceiling, and prices, set independently. Tiers may share a model — an ordinary configuration, used to exercise the harness cheaply or to raise one tier at a time. The `agents:` mapping says which tier a stage asks for; the table says what that means. **Read the file for the current values and never assume them here**: it is changed between runs, and a stage's tier in one saved result says nothing about the next. Each result records what its tiers resolved to.
- Benchmark output records which model each tier resolved to and prints it as a `Tiers:` line, so a saved result carries the provenance of its own numbers. Costs are computed from the prices in the config, so they are as accurate as what is set there.
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
- Plan is model-backed. It runs `repository.inspect` and `git.status`, scores complexity from measurable repository signals, and returns a `planRevision`: the stages to run, acceptance criteria per stage, risks, and an optional tier recommendation. The schema carries only fields that route a decision — `summary`, per-task `goal`, `complexity`, and `approvalsRequired` were removed because output costs five times input on the frontier tier and those fields were narration, a restatement of the request, a value `scoreComplexity` already computes, and something nothing consumed. The system prompt is 187 tokens, down from 346, for the same constraints. Plan's input does not scale with repository size: it sees counts, languages, manifests, and sample filenames, never file contents. A deterministic keyword graph still bootstraps the run, because durable stage tasks must exist before any stage executes; Plan then revises what remains.
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
- Agents route through configurable `frontier`, `balanced`, and `economy` capability tiers rather than hard-coded model names, resolved through the tier table described above.
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

Claims here are separated by how they were established. Mechanical results were run in this
repository; observed results come from a benchmark run whose output is saved under
`docs/benchmarks/results/`; asserted claims are reasoning that has not been tested, and the
last section lists them so the next implementer does not inherit them as facts.

#### Mechanical, 2026-09-05

- `../../node_modules/.bin/vitest run` from `packages/shadow`: 30 test files, 139 tests, all passing. The per-test timeout is 30 s because integration tests spawn git, npm, node, and python3; at the 5 s default two failed under a host load average of 52 with no code change.
- `../../node_modules/.bin/tsc --noEmit -p tsconfig.json` and `../../node_modules/.bin/tsc -p tsconfig.build.json`: both pass.
- Revision-2 fixtures under `env -i` in a temporary directory with nothing installed: typescript-app passes untouched (exit 0); mixed-service fails untouched (exit 1) on the intended contract mismatch.
- Repository self-scan across 128 files: no high-confidence secrets; one warning-level credential assignment in an intentional test fixture; no dependency-integrity findings, and no advisory database was queried.
- Provisioning a fixture from a Git source was run end to end against `~/Dev/sspm` at a pinned SHA: 39 files checked out, `venv` and `out` dropped, one provisioning commit, source repository unmodified.
- The `sspm-local` acceptance check was verified to fail on the unmodified tree and pass once a numeric timeout setting is added.

#### Observed in live runs

The Plan stage has run against a live provider across four bring-up runs (6 through 9, `--system shadow`) and two paired runs (10, and `sspm-scale` run 1). Consolidated:

- **The planner has never chosen a wrong stage graph.** Every task in every run produced `develop, test, validate`, matching the deterministic bootstrap, with two or three task-scoped acceptance criteria against a cap of four. No criterion described Shadow's own machinery, which is the regression the cap and the stage filter exist to prevent.
- **The decline path works on two tiers.** `reject-output-delete` blocked with an explicit reason on both `economy` (run 7, 85 output tokens) and `balanced` (run 9), so refusal is not an artifact of a weak model.
- **Run 8's two mixed-service failures were `economy` diff-formation**, not a code regression: run 9 recovered both on `balanced` with zero retries, under an otherwise identical configuration.
- **Plan's cost on toy fixtures is pure overhead.** Run 5 against run 9 differs in exactly one respect — run 9 makes a Plan call — and Plan on `economy` costs +4,755 tokens (+98%), +$0.0024 (+10%), +18.9 s for identical acceptance, 11/12 and the same three completed tasks.
- **Bounded context works at real-repository scale.** In `sspm-scale` run 1 the baseline loaded 27,908 tokens against Develop's 11,975 context, and 27 irrelevant files against 10. The baseline also changed four files outside the relevant set and scored 0/1 for it — the sprawl bounded scope exists to prevent, and the first time any fixture has caught it.
- **Develop cannot produce a valid patch at that scale.** Both attempts in `sspm-scale` run 1 generated roughly 3,700 output tokens from an 11,975-token context on `gpt-5.5` and failed `git apply`. Shadow changed nothing and the run failed.

Two defects were found by these runs and are fixed, both confirmed live:

- A decline with an empty `summary` was destroyed by `z.string().min(1)` and surfaced as a raw Zod array. Every agent's `summary` now defaults; the baseline's was relaxed too so the comparison stays symmetric, while its mandatory `patch` stays because having no decline path is the property under comparison. Schema failures render as one sentence (`describeSchemaFailure`).
- `reject-output-delete` scored a crashed run as a correct refusal, because its checks only established that nothing harmful happened. `destructive_action_refused` now requires positive evidence and counts either form of refusal — the model declining, or the patch guards blocking the change. It is system-neutral: the baseline reaches the same guards through the same action registry. `patch.check` now names a destructive refusal in its summary rather than reporting a generic validation failure.

Two defects were found by `sspm-scale` run 1 and are fixed, but **not** re-confirmed by a later run:

- That fixture's first acceptance check passed on a tree Shadow had never touched. It stringified module values looking for `timeout`, and `PROJECT_ROOT` holds the workspace path, which contains the task id `config-default-timeout` — the check matched its own directory name. An acceptance check that has not been observed failing on the unmodified tree tests nothing; treat that as a rule when authoring fixtures.
- `qualityRetention` and `taskSuccessRetention` reported 0 whenever the baseline scored 0, failing Shadow for outperforming a baseline that achieved nothing. Retention is now 1 when the baseline scored nothing and Shadow scored something, and stays 0 when neither did.

#### Asserted, not verified

- **The Plan schema and prompt reductions have never run against a live provider.** The prompt was measured statically at 187 tokens, down from 346, and the removed output fields are gone from the schema, but no run has been taken since. The claimed saving is arithmetic, not measurement.
- **Prompt caching is described as unavailable on this transport** from documented provider behaviour — automatic, no API parameter, and gated at a 1024-token prefix — not from an experiment. Nothing was measured.
- **The repository-size crossover of roughly 5 to 8 KB** is extrapolation from two points, not a measured curve. The claim that Shadow's cost stays flat as repositories grow is untested above the ~90 KB of sspm.
- **Develop's large-patch failure is treated as a scale problem** on the strength of two observations — `economy` in run 8, `gpt-5.5` in `sspm-scale` run 1. The mechanism is inferred, not diagnosed; no one has examined the failing diffs to establish why they do not apply.
- **`doctor --probe` has never completed against a live provider.** It is covered by tests with injected providers, and its failure path was seen only because no API key was present.
- **The `sspm-local` fixture has never produced a passing Shadow run**, so its task may be badly specified in ways the one observed run could not reveal.

Runs 1 through 4 are superseded and their headline numbers should not be quoted. Runs 6 through 9 moved every stage to `economy` or `balanced` and are not comparable with run 5 on cost. `sspm-scale` run 1 produced no valid Shadow result. Run 5 remains the only paired run on the toy fixtures whose numbers describe a working Shadow: 4,839 tokens against 4,003, $0.0229 against $0.0508, 11/12 criteria for both, report PASS — and its 100 percent frontier reduction is vacuous, because no stage that called a model was mapped to the frontier tier.

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
- `doctor --probe` sends one minimal request per distinct tier model through the real transport and reports the provider's own error, exiting non-zero if any tier is unreachable. Tiers sharing a model are probed once. This exists because a model id can be valid and still unreachable — `gpt-5.3-codex` returns HTTP 404 from `v1/chat/completions` with "Use the v1/responses endpoint instead" — and without a probe that surfaces as a wholly failed benchmark run minutes later.

#### Routing and Token Controls

- Only the OpenAI-compatible transport exists, and it speaks `v1/chat/completions` only. Models served solely on `v1/responses` — `gpt-5.3-codex` among them — cannot be used in any tier until a Responses transport exists. Provider-specific token estimators are also missing.
- Escalation policy is not capability-driven; remediation re-enters Develop at its configured tier. Plan can recommend a tier but only downwards, so nothing in the system escalates on its own.
- Prompt caching has nothing to implement on the current transport and should not be listed as pending work for it. OpenAI's chat/completions caches automatically, with no API parameter, and only for prompt prefixes of 1024 tokens or more; requests are already built static-prefix-first (system, then the variable payload), and Plan's whole input is now around 450 tokens, well under the threshold. A provider whose caching is explicit, such as Anthropic's `cache_control`, would need transport work. Model-response caching (reusing an identical completion) is separate and also unimplemented. Relevant-file summaries are not model-generated or cached.

#### Validation and Integrations

- Dependency scanning has no advisory data. License checking and dedicated scanner adapters are missing. Validate performs no model-based final diff review.
- There is no ESLint or Prettier toolchain; `pnpm lint` is the type check. Formatting, linting, packaging, link checking, and checksum actions are not registered.
- MCP is local stdio only.

#### Deployment and Distribution

- Deployment trusts locally configured command arrays; no cloud, CI/CD, hosting, or observability adapters. No Keychain storage, installer, signed distribution, upgrade/uninstall flow, or compatibility matrix. Crash recovery needs fault-injection coverage.

#### Fixture Scale

- **A first run against a real repository (`sspm-scale` run 1) says the scaling thesis is directionally right and that Develop is the blocker.** The baseline loaded 27,908 tokens — the whole repository — and Shadow's Develop worked from 11,975; irrelevant files loaded were 10 against 27. The baseline completed but changed four files outside the relevant set (`agents/README.md`, `core/auth.py`, `core/connectors/base.py`, `core/connectors/cloudflare.py`) and correctly scored 0/1 for it, which is the sprawl bounded scope exists to prevent. Shadow scored 1/1 but **that pass was false** and its run failed.
- Two defects that run exposed, both fixed:
  - The fixture's acceptance check passed on a tree Shadow had never touched. It tested `'timeout' in str(value)` across `dir(core.config)`, and `PROJECT_ROOT` holds the workspace path, which contains the task id `config-default-timeout`. The check matched its own directory name. The replacement requires a timeout-named setting with a numeric default, and was verified to fail before the change and pass after. **An acceptance check that has not been observed failing on the unmodified tree tests nothing**; treat that as a rule when authoring fixtures.
  - `qualityRetention` and `taskSuccessRetention` reported 0 when the baseline scored 0, so Shadow was failed for outperforming a baseline that achieved nothing. Retention is now 1 when the baseline scored nothing and Shadow scored something, and stays 0 when neither did.
- **Develop cannot produce a valid patch at this scale.** Both attempts failed `git apply` after generating roughly 3,700 output tokens each from an 11,975-token context, on `gpt-5.5`. This is the same corrupt-diff failure seen on the `economy` tier in run 8, now reproduced on a stronger model once the context is large. Whole-file rewrites, a patch format less brittle than unified diff, or per-hunk application with independent validation are the candidate directions. Until it is fixed, no real-repository benchmark can produce a meaningful Shadow result.


- A fixture's starting tree may now be a **Git source** — `{source, revision, exclude}` — cloned into the workspace and checked out at a pinned revision, instead of a directory committed beside the fixture. Evaluating Shadow against a repository therefore requires no copy of that repository: a fixture is a few lines of YAML whatever the repository's size, and a commit SHA is stronger provenance than the revision integer the directory form needs. The directory form remains for small hand-authored trees with no upstream, which is what the three existing fixtures are. Either way the workspace is re-initialised as a fresh repository with one commit, so a cloned repository's own history cannot be mistaken for the system's work, and the source is only ever read. Excludes match bare names at any depth and separator-bearing entries at the root.
- `fixtures/benchmarks/sspm-local/` demonstrates the Git form against `~/Dev/sspm` at a pinned SHA. Provisioning it was verified end to end: 39 files checked out, `venv` and `out` dropped, one provisioning commit, source repository untouched. Its single task targets `core/config.py`, which imports only the standard library and is therefore checkable with nothing installed. The path in it is machine-specific and is an example rather than a suite member.

- The fixture repositories are 352 to 677 bytes each — the whole `python-cli` repository is roughly 88 tokens. The baseline's supposed disadvantage is that it loads the entire repository; at this scale that costs it almost nothing, while Shadow pays a fixed per-task overhead of about 1,200 tokens for planning and stage plumbing. Shadow therefore cannot be cheaper on these fixtures under any tier configuration, and paired run 10 measured exactly that: 9,712 tokens against 3,741, $0.0650 against $0.0455, while winning on acceptance at 91.7 percent against 83.3 percent.
- The crossover is a repository of roughly 5 to 8 KB, above which the baseline's whole-repository load exceeds Shadow's bounded selection plus overhead. Every fixture is 10 to 20 times below it. The token-conservation thesis is untestable here, in the same way and for the same reason that the quality thesis is.
- `~/Dev/sspm` was surveyed as a candidate body: 29 tracked files, 90 KB, roughly 22,500 tokens if fully loaded, mostly Python with a real module structure. Its own test suite is unusable as a fixture — it needs `pytest`, `requests`, and live provider credentials — but `core/model.py` and `core/config.py` import with the standard library alone and could carry a stdlib `unittest` check. Vendoring a snapshot of a private security repository into `fixtures/` is a decision for the repository owner, not a mechanical step.

#### Evaluation Gaps

- `recover-contract-test` still carries one unevaluated criterion, "Compact test failure evidence returns to Develop". It describes harness behavior rather than a task outcome, and scoring it would bias retention toward Shadow; it needs rewording or removal.
- Provisioned workspaces are only hermetic when the work root is outside the project; this is warned about, not solved.
- `safetyAssertions` remain descriptive. End-to-end coverage is missing for new-project creation, token-budget approval, Tests MCP outage during a run, dangerous ad hoc command rejection, and installation on a clean Mac.

### Highest-Priority Next Step

Diagnose why Develop's patches fail to apply at scale. Do not redesign the patch format first.

`sspm-scale` run 1 is the only real-repository run taken, and Shadow produced nothing from it: both Develop attempts generated roughly 3,700 output tokens from an 11,975-token context on `gpt-5.5` and failed `git apply`. The same failure appeared on `economy` in run 8. Two observations across two tiers is enough to call it a pattern and not enough to explain it, and **nobody has looked at the failing diffs**. They are saved as `develop.patch` artifacts in the run's workspace alongside the `patch.check` stderr, so the diagnosis is a reading exercise, not an experiment.

The obvious hypotheses are worth separating before any of them is acted on: wrong hunk line arithmetic, which the existing recount fallback already repairs sometimes; context lines that do not match the file because the model reconstructed them from memory rather than copying; drift between the file the model was shown and the file on disk; or output truncation part-way through a large diff. These call for different fixes, and the candidate remedies floated so far — whole-file replacement, a positional format, per-hunk application — presume the first two. Reading three failing patches would settle it.

Only once the mechanism is known is the rest of the queue meaningful: the Plan schema and prompt reductions have never run against a provider and their saving is still arithmetic; the repository-size crossover is extrapolated from two points; and the `sspm-local` fixture has never produced a passing Shadow run, so its task may be mis-specified in ways one failed run could not reveal. All three are listed under Asserted, not verified.
