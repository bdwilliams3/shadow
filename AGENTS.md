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

- Last rewritten: 2026-09-07 (evening), after the single-model baseline gained one bounded repair attempt with artifact evidence, aggregate retry budgeting, retry accounting in benchmark observations, compiled support for loose `*** Update File` apply-patch fragments after malformed diff preambles, order-independent placement for unique apply-patch hunks, the same task contract Shadow receives, pre-apply repair for valid patches that exceed relevant-file scope, corrected benchmark accounting for Shadow calls to the selected baseline provider/model, patch-action cleanup for stray apply-patch sentinels wrapped around an otherwise unified diff, and a user-terminal paired `sspm-local` run showing Shadow beating a `gpt-5.5` baseline on correctness, tokens, cost, latency, and irrelevant context. The CLI package was rebuilt. The repository owner confirmed `shadow --help` works after local linking, despite npm warning/error noise from using npm against a pnpm workspace.
- Implementation shape: runnable cross-phase vertical slice. Phases 0 through 4 are substantially represented, Phase 5 is partially implemented, and Phase 6 has not started. This does not mean every exit criterion in the represented phases is complete.
- `.shadow/config.yaml` is now provider-grouped and direct-alias-first. `providers.<provider>.models.<alias>` declares model id, limits, prices, and reserved-budget accounting; `agents:` maps each SDLC stage directly to an alias or to the provider model ID when that ID uniquely matches a configured model, e.g. either `plan: gpt-5-6-luna` or `plan: gpt-5.6-luna` can resolve to `providers.openai.models.gpt-5-6-luna`. The OpenAI provider includes additional aliases for `gpt-6-astra` and `gpt-5.6-luna`; the Google provider includes additional aliases for `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, and `gemini-2.5-flash`, using current Standard API text rates and documented output-token ceilings where available. **Read the file for current values and never assume them here**: it is changed between runs, and a stage's alias in one saved result says nothing about the next.
- Benchmark output can record a `Models:` alias table and per-system `Model usage` lines so a saved result carries the provenance of its own numbers and costs. Older reports with `Tiers:` still parse. Costs are computed from the prices in config, so they are as accurate as what is set there. The old headline "Frontier tokens" is now printed as `Reserved/baseline-model tokens`: it counts calls to aliases marked `reservedBudget` and Shadow calls whose resolved provider/model matches the selected baseline model. This prevents a run where Plan uses the same physical model as `--benchmark-model` from reporting `0` Shadow comparison tokens only because the alias is not reserved.
- `benchmark run --benchmark-model <alias-or-model-id>` selects the single-model baseline explicitly. This lets the Shadow side use its configured per-stage harness while the baseline is pinned to any configured alias or unique provider model id, e.g. `--benchmark-model gpt-6-astra` or `--benchmark-model gpt-5.6-luna`. Without the flag, the baseline still falls back to the first reserved-budget alias for compatibility.
- Benchmark workspace entries now include a compact system summary and `formatBenchmarkExecution` prints it when a system fails or blocks. This was added after a Gemini baseline run selected `google/gemini-3.8`, spent zero tokens, and failed only through the downstream acceptance check, leaving no visible distinction between missing credits/quota, bad key, unsupported model, transport mismatch, schema failure, or patch failure.
- The single-model baseline now receives the same task contract as Shadow: acceptance criteria, relevant files, permitted side effects, expected evidence, and safety assertions. It still does not receive deterministic acceptance-check commands. The baseline gets one bounded repair call when `patch.check` rejects the first patch for a non-safety syntax or applicability failure, or when a valid patch changes files outside the relevant-file scope before application. Destructive changes, paths outside the workspace, symlinks, and binary patches still stop at the guard. Both the original and repaired patches are stored as artifacts, usage is accumulated, and benchmark `retries` records the extra model call. Patch actions also normalize loose apply-patch fragments such as `*** Update File: path` when they appear after malformed diff preamble, translating only the fragment through the existing envelope path and then running the normal Git and safety checks. Unique hunks may arrive out of file order; the translator now falls back to locating them independently, sorts them by file position, and refuses overlaps instead of guessing.
- Runtime baseline: Node.js 22.11 or newer, TypeScript 5.x strict ESM, pnpm 10.15.0 workspace, macOS-first.
- Primary package: `packages/shadow`.
- Persistence: local SQLite metadata plus content-addressed artifact files under `.shadow`.

### Current Capabilities

#### CLI and Sessions

- `shadow` opens a readline-based interactive terminal session scoped to the current working directory.
- The package can be built with `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` and linked locally with `npm link ./packages/shadow`; the repository owner reported `shadow --help` displaying the command table after linking. npm may print peer-dependency warnings or `Cannot read properties of null (reading 'matches')` when linking this pnpm workspace, but the binary can still be available. Prefer confirming with `which shadow` and `shadow --help` before trying to relink.
- The next product direction is to make bare `shadow` the primary command-line chatbox: a plain terminal chat in the current repository where normal user text starts the lifecycle, deterministic readiness checks run before token-spending flows, progress is concise, and slash commands stay minimal. Benchmarks should move back to regression evidence after meaningful harness changes rather than driving the day-to-day product loop.
- Implemented commands include `run`, `init`, `resume`, `status`, `models`, `actions list`, `mcp list`, `config validate`, `doctor`, `logs`, `approve`, `reject`, `cancel`, `benchmark run`, `benchmark observe`, and `benchmark report`. `benchmark report` and `benchmark run --report` print absolute totals for a single-system run instead of throwing: every gate except dangerous-action rejection is a ratio against the baseline, so a one-system run reports rather than passes or fails. This is what makes a `--system shadow` bring-up run legible without paying for the frontier baseline.
- Interactive commands include status, plan, diff, budget, approval, rejection, cancellation, model/action inspection, and exit flows.
- Non-interactive `shadow run` and `shadow resume` exit non-zero when the run ends failed or cancelled. Any command error prints one line and exits 1 rather than a stack trace. The interactive loop sets no exit code.
- Runs, stage tasks, stage attempts, events, approvals, usage, cancellation requests, and artifact references are durable and resumable through SQLite.
- Legacy JSON/JSONL run data has a one-time import path into SQLite.

#### Lifecycle Orchestration

- The explicit state machine supports Plan, Design, Develop, Test, Validate, Deploy, and Document stage runs, including stage skipping, bounded retries, cancellation propagation, model-call limits, approval pauses, and resume.
- All seven lifecycle stages have concrete agents. Test, Validate, and Deploy are deterministic; Plan, Design, Develop, and Document call a model. `shadow models` prints each stage's configured alias and resolved provider/model, and annotates the deterministic three, whose configured alias is inert unless those stages later gain model-backed behavior.
- Plan is model-backed. It runs `repository.inspect` and `git.status`, scores complexity from measurable repository signals, and returns a `planRevision`: the stages to run, acceptance criteria per stage, risks, and an optional tier recommendation. The schema carries only fields that route a decision — `summary`, per-task `goal`, `complexity`, and `approvalsRequired` were removed because output costs five times input on the frontier tier and those fields were narration, a restatement of the request, a value `scoreComplexity` already computes, and something nothing consumed. The system prompt is 187 tokens, down from 346, for the same constraints. Plan's input does not scale with repository size: it sees counts, languages, manifests, and sample filenames, never file contents. A deterministic keyword graph still bootstraps the run, because durable stage tasks must exist before any stage executes; Plan then revises what remains.
- A revision is a proposal, not an instruction. The orchestrator applies it only to stages after the current index, filters to `lifecycle.enabledStages`, restores canonical stage order, and keeps allowed tools and write permissions from the stage table. Surviving stages keep their task id, so resume, approvals, and remediation bookkeeping stay coherent. A `run.replanned` event records the before and after graphs, the criteria, and the tiers.
- Direct stage aliases are configuration authority. Plan may still emit older capability recommendations, but the orchestrator records them as advisory risks and keeps the configured alias; a model cannot quietly rewrite the operator's stage-to-model map.
- Explicit acceptance criteria supplied with a run, such as benchmark task criteria, are also authority. The deterministic bootstrap attaches them to criteria-consuming stages, and Plan revisions preserve them instead of replacing them with broader model-generated criteria. This prevents a scoped task like "add a config default in `core/config.py`" from failing because Plan expanded "done" into changing outbound connector call sites while Develop was only allowed to edit the relevant file.
- Acceptance criteria are capped at four per stage and attached only to Design, Develop, and Document, enforced in code rather than requested in the prompt. This is the guard against the recorded failure where run-level invariants handed to Develop as criteria made a live model decline an ordinary two-file edit for lacking "orchestration, persistence, budgeting, and policy-evaluation components".
- A failed or budget-refused Plan call keeps the deterministic graph, completes the stage, and records a risk: planning improves the lifecycle but is not a precondition for it. An approval-required routing error is the exception and returns `blocked`, so the approval pause still surfaces. Plan runs while the run is still `PLANNED`, so `PLANNED -> AWAITING_APPROVAL` is now a legal transition — Plan is the first stage that can pause before `EXECUTING`.
- Develop selects bounded repository context, requests a unified diff, checks scope and selected-file hashes, and applies approved workspace changes through the tool gateway. Stage tasks may carry an optional `allowedChangedFiles` list; when present, Develop ranks those files first, sends only that bounded file set to the model, and rejects any patch that touches a file outside the allowed set before `patch.apply`.
- Develop can decline. `patch` is optional with a `declineReason`; an empty patch blocks the run with that reason in one model call. Requiring a non-empty patch had forced the model to fabricate one and run to the output ceiling.
- Develop can create new files. The created set comes from `git apply --summary`, never from a model claim; creations are capped at ten per attempt.
- A terminal Test or Validate failure routes back into a bounded Develop remediation cycle with a compact failure artifact (stage, reason, summary, normalized failures, open risks, changed files, failed tool summaries). Raw output stays in separate artifacts. Bounded by `lifecycle.maxRemediationCycles` (default 1); disabled for dry runs; retry and model-call budgets are scoped per cycle; attempt history is preserved.
- A test or type-check runner that cannot be started, or that exits 127, is reported as `unavailable`: the stage is skipped with a visible risk and never enters remediation. Run 2 had fed a missing Vitest binary into a remediation cycle and failed a task whose code was correct.
- Tests MCP now also treats a configured pytest project whose selected Python environment reports `No module named pytest` as `not_configured` during discovery or execution. Before this, the `sspm-local` run passed every deterministic acceptance check but failed the lifecycle because Tests MCP converted missing pytest into one failed test, triggering unnecessary Develop remediation.
- Test selects tests from changed files and indexed relationships, prefers Tests MCP, and falls back to a registered local action.
- Validate runs Git scope inspection, type checking, secret scanning, and dependency-integrity scanning.
- Deploy uses configured deterministic command arrays with a dry-run preview, explicit approval, health verification, durable receipts, duplicate-deploy prevention on resume, and separately approved rollback.
- Document uses verified implementation evidence and may patch only selected existing documentation files.

#### Models, Context, and Budgets

- Provider calls are behind a generic adapter interface with OpenAI-compatible, Anthropic Messages, and Google Gemini implementations. The OpenAI-compatible adapter sends `max_completion_tokens` by default (`maxCompletionTokensParam: false` selects the older `max_tokens`), strips keywords OpenAI's strict structured outputs rejects from Zod-generated JSON schemas, includes the provider's error body in failures, reports a response cut off at the output ceiling as truncation rather than parsing the fragment, and abandons any request after `requestTimeoutMs` (default 120 s). Anthropic and Google transports are minimal but use the same provider interface, timeout behavior, schema instruction path, and usage normalization.
- Agents route through configured model aliases rather than hard-coded model names or fixed `frontier` / `balanced` / `economy` buckets. Provider-local aliases are resolved as `stage -> alias/model id -> provider/model config -> provider adapter`. A stage may reference either the alias key or the provider's `model` string if that model string is unique; duplicate model IDs require an explicit alias so routing does not guess. The legacy flat `models:` table is still accepted so older configs continue to load, but new configs should define aliases under providers.
- Model routing performs preflight input, output, total-token, estimated-cost, stage, run, and reserved-budget checks. Reserved-token accounting is controlled by model metadata (`reservedBudget: true` or legacy `frontier: true`), not by alias names.
- Repository context uses Git-aware discovery, Shadow exclusions, bounded reads, content hashes, SQLite FTS5 lexical search, import proximity, and symbol extraction. TypeScript and JavaScript symbols use the TypeScript compiler API; Python metadata uses a batched standard-library AST helper.
- Context selection now augments lexical queries with small code-oriented aliases (`configuration`/`settings` -> `config`, singular/plural connector forms) and deterministic path/symbol/import affinity before content ranking. This was added after the `sspm-local` audit run selected Cloudflare connector bodies and posture docs while omitting `core/config.py` for a configuration request. Explicit `candidatePaths` are treated as strong hints. Files that do not fit in the remaining context budget are skipped instead of truncated once selected; partial source files led to brittle patch generation.
- Develop passes its Plan acceptance criteria and constraints into context selection, caps its initial context at four files and 24 KB, and tells the model to prefer the smallest patch against the highest-ranked relevant file. When a benchmark task declares relevant files, `benchmark run` passes them as `allowedChangedFiles`; this is an executable scope boundary, not a prompt hint, and is meant to prevent a broad selected neighborhood from turning a one-file configuration change into a multi-file connector rewrite.
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
- `benchmark report` gates on frontier-token reduction (40 percent), criteria retention (90 percent), task-completion retention (90 percent, ADR 0016), median interventions (at most one more), and dangerous-action rejection (100 percent, vacuously met when nothing dangerous was attempted). Comparisons use a tolerance so an exactly-met ratio is not failed by float representation. `Tasks completed` is printed. Single-system summaries accept even a single observation instead of tripping over the paired-report schema.
- `benchmark run --out` now records the provisioned `workRoot` and a `workspaces` audit list in the saved JSON, including fixture id, task id, system, workspace root, final status, changed files, failed acceptance checks, and artifact references. Observations remain the source for aggregate scoring. This was added because the saved `sspm-scale` run kept only aggregate counts, while the local temp workspace containing the failing `develop.patch` and `patch.check` evidence was no longer findable from the result file.
- Real results live under `docs/benchmarks/results/`. Architecture decisions 0001 through 0016 are recorded.

### Verified State

Claims here are separated by how they were established. Mechanical results were run in this
repository; observed results come from a benchmark run whose output is saved under
`docs/benchmarks/results/`; asserted claims are reasoning that has not been tested, and the
last section lists them so the next implementer does not inherit them as facts.

#### Mechanical, 2026-09-06

- `./node_modules/.bin/vitest run packages/shadow/test --testTimeout 10000` from the repository root: 30 test files, 145 tests, all passing. The same full suite under Vitest's default 5 s per-test timeout had one remediation recovery test time out at 5.010 s under concurrent load before the Tests MCP fix; rerunning `packages/shadow/test/remediation.test.ts` alone passed all 4 tests.
- `./node_modules/.bin/vitest run packages/shadow/test/develop-agent.test.ts packages/shadow/test/builtin-actions.test.ts packages/shadow/test/benchmark-executor.test.ts`: 3 files, 22 tests, all passing.
- `./node_modules/.bin/vitest run packages/shadow/test/tests-mcp.test.ts packages/shadow/test/remediation.test.ts`: 2 files, 8 tests, all passing.
- `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` and `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json`: both pass.
- After direct model-alias routing: `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `./node_modules/.bin/vitest run packages/shadow/test --testTimeout 10000` passed 30 files and 146 tests on rerun except one load-sensitive `tests-mcp` polling timeout in the concurrent full-suite run; `./node_modules/.bin/vitest run packages/shadow/test/tests-mcp.test.ts --testTimeout 10000` passed 4/4 immediately after. `node packages/shadow/dist/cli/index.js config validate` passes against the repo config, and `node packages/shadow/dist/cli/index.js models` prints the direct alias routing table.
- After expanding Gemini aliases: `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `./node_modules/.bin/vitest run packages/shadow/test/config.test.ts --testTimeout 10000` passes 3/3; `node packages/shadow/dist/cli/index.js config validate` passes against the repo config; `node packages/shadow/dist/cli/index.js models` still resolves the configured active stage aliases.
- After expanding OpenAI aliases: `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `./node_modules/.bin/vitest run packages/shadow/test/config.test.ts --testTimeout 10000` passes 3/3; `node packages/shadow/dist/cli/index.js config validate` passes against the repo config.
- After accepting provider model IDs in `agents:`: `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/vitest run packages/shadow/test/config.test.ts --testTimeout 10000` passes 5/5; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `node packages/shadow/dist/cli/index.js config validate` passes against the repo config with `plan: gpt-5.6-luna` and `design/develop/deploy: gpt-5.5`; `node packages/shadow/dist/cli/index.js models` resolves those exact values to the configured OpenAI models.
- After preserving explicit acceptance criteria: `./node_modules/.bin/vitest run packages/shadow/test/plan-agent.test.ts packages/shadow/test/config.test.ts --testTimeout 10000` passes 21/21; `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `node packages/shadow/dist/cli/index.js config validate` passes. The failing `gemini-openai-benchmark-1` shape was diagnosed from its temporary SQLite run data: Plan broadened Develop criteria, Develop declined because only `core/config.py` was in scope, and no patch artifact was created.
- After adding `--benchmark-model`: `./node_modules/.bin/vitest run packages/shadow/test/benchmark-executor.test.ts packages/shadow/test/config.test.ts --testTimeout 10000` passes 15/15; `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `node packages/shadow/dist/cli/index.js benchmark run --help` shows `--benchmark-model <alias-or-model-id>`; an invalid value reports `Benchmark model ... is not configured` without making a model call.
- After surfacing baseline failure summaries: `./node_modules/.bin/vitest run packages/shadow/test/benchmark-executor.test.ts packages/shadow/test/benchmark-report.test.ts --testTimeout 10000` passes 25/25; `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `git diff --check` passes. A no-token CLI probe with an invalid benchmark model reports the configuration error cleanly.
- After adding baseline invalid-patch repair, loose-fragment normalization, out-of-order hunk placement, task-spec parity, and out-of-scope repair: `./node_modules/.bin/vitest run packages/shadow/test/apply-patch-envelope.test.ts packages/shadow/test/patch-actions.test.ts packages/shadow/test/benchmark-executor.test.ts` passes 29/29; `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `git diff --check` passes. A direct compiled-JS action replay against the user's saved `baseline.repair-1.patch` from `gemini-openai-benchmark-frontier-7.json` applies successfully and affects `core/auth.py`, `core/config.py`, `core/connectors/base.py`, and `core/connectors/cloudflare.py`. Re-scoring that replay passes `timeout-present` and fails `scope-limited`, which is a legitimate quality failure rather than a patch-parser failure. A live paired `sspm-local` run from the Codex shell was blocked before model calls because the provider API-key environment variables were absent there.
- After correcting benchmark accounting for direct aliases and per-model costs: `./node_modules/.bin/vitest run packages/shadow/test/benchmark-observe.test.ts packages/shadow/test/benchmark-report.test.ts packages/shadow/test/benchmark-executor.test.ts packages/shadow/test/apply-patch-envelope.test.ts packages/shadow/test/patch-actions.test.ts` passes 46/46; `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `git diff --check` passes; `node packages/shadow/dist/cli/index.js config validate` passes. New observations count Shadow calls to the selected baseline provider/model in the reserved/baseline-model bucket even when their direct alias is not marked `reservedBudget`, and paired reports print per-model token and dollar totals for each system.
- After cleaning stray apply-patch sentinels from unified diffs: `./node_modules/.bin/vitest run packages/shadow/test/patch-actions.test.ts packages/shadow/test/apply-patch-envelope.test.ts` passes 17/17; `./node_modules/.bin/tsc --noEmit -p packages/shadow/tsconfig.json` passes; `./node_modules/.bin/tsc -p packages/shadow/tsconfig.build.json` passes; `git diff --check` passes. A direct compiled-JS `patch.check` replay against the user's saved Shadow `develop.patch` from `gemini-openai-benchmark-frontier-12.json` now completes and reports `changedFiles: ["core/config.py"]`, after removing the stray `*** End Patch` line and recounting malformed hunk counts.
- `git diff --check`: pass.
- Revision-2 fixtures under `env -i` in a temporary directory with nothing installed: typescript-app passes untouched (exit 0); mixed-service fails untouched (exit 1) on the intended contract mismatch.
- Repository self-scan across 128 files: no high-confidence secrets; one warning-level credential assignment in an intentional test fixture; no dependency-integrity findings, and no advisory database was queried.
- Provisioning a fixture from a Git source was run end to end against `~/Dev/sspm` at a pinned SHA: 39 files checked out, `venv` and `out` dropped, one provisioning commit, source repository unmodified.
- The `sspm-local` acceptance check was verified to fail on the unmodified tree and pass once a numeric timeout setting is added.

#### Observed in live runs

The Plan stage has run against a live provider across four bring-up runs (6 through 9, `--system shadow`) and three paired runs (10, `sspm-scale` run 1, and `2026-09-06-sspm-scale-paired-pytest-unavailable.json`). Consolidated:

- **The planner has never chosen a wrong stage graph.** Every task in every run produced `develop, test, validate`, matching the deterministic bootstrap, with two or three task-scoped acceptance criteria against a cap of four. No criterion described Shadow's own machinery, which is the regression the cap and the stage filter exist to prevent.
- **The decline path works on two tiers.** `reject-output-delete` blocked with an explicit reason on both `economy` (run 7, 85 output tokens) and `balanced` (run 9), so refusal is not an artifact of a weak model.
- **Run 8's two mixed-service failures were `economy` diff-formation**, not a code regression: run 9 recovered both on `balanced` with zero retries, under an otherwise identical configuration.
- **Plan's cost on toy fixtures is pure overhead.** Run 5 against run 9 differs in exactly one respect — run 9 makes a Plan call — and Plan on `economy` costs +4,755 tokens (+98%), +$0.0024 (+10%), +18.9 s for identical acceptance, 11/12 and the same three completed tasks.
- **Bounded context works at real-repository scale.** In `sspm-scale` run 1 the baseline loaded 27,908 tokens against Develop's 11,975 context, and 27 irrelevant files against 10. The baseline also changed four files outside the relevant set and scored 0/1 for it — the sprawl bounded scope exists to prevent, and the first time any fixture caught it.
- **The paired `sspm-local` gate now passes.** `2026-09-06-sspm-scale-paired-pytest-unavailable.json` completed with 2 observations. Shadow completed with criteria 1/1, 5,243 total tokens, 956 frontier tokens, $0.0384 estimated cost, 22.9 s latency, 0 irrelevant files loaded, and 0 interventions. The baseline completed its run but scored criteria 0/1 because it changed files outside the relevant set: `agents/README.md`, `core/auth.py`, `core/connectors/base.py`, `core/connectors/cloudflare.py`, and `tests/test_config.py`. The report passed: 96.6 percent frontier-token reduction, 100 percent task-completion retention, 100 percent acceptance retention, 100 percent dangerous-action rejection, and no unevaluated criteria.
- **The latest user-terminal `sspm-local` run against a `gpt-5.5` baseline is `gemini-openai-benchmark-frontier-13.json`.** Shadow completed with criteria 1/1 while the baseline completed mechanically but scored 0/1 because the acceptance command hit `IndentationError: unexpected indent`. Shadow used 4,403 total tokens and $0.0046 estimated cost against the baseline's 26,406 tokens and $0.0742; latency was 16.6 s against 20.4 s; irrelevant files loaded were 0 against 27. Shadow's baseline-model bucket was 709 tokens because Plan used `openai/gpt-5.5`, while Develop used `openai/gpt-5.6-luna` for 3,694 tokens. This is strong evidence for the token/cost/context thesis against that configured baseline, but it is not a clean both-systems-pass quality comparison.
- **Develop's earlier large-context patch failure is superseded for `sspm-local`.** Both attempts in `sspm-scale` run 1 generated roughly 3,700 output tokens from an 11,975-token context on `gpt-5.5` and failed `git apply`. Later affinity, context-cap, allowed-scope, and pytest-unavailable runs narrowed the failure sequence; the paired passing run changed only the relevant file and completed.

Two defects were found by these runs and are fixed, both confirmed live:

- A decline with an empty `summary` was destroyed by `z.string().min(1)` and surfaced as a raw Zod array. Every agent's `summary` now defaults; the baseline's was relaxed too so the comparison stays symmetric, while its mandatory `patch` stays because having no decline path is the property under comparison. Schema failures render as one sentence (`describeSchemaFailure`).
- `reject-output-delete` scored a crashed run as a correct refusal, because its checks only established that nothing harmful happened. `destructive_action_refused` now requires positive evidence and counts either form of refusal — the model declining, or the patch guards blocking the change. It is system-neutral: the baseline reaches the same guards through the same action registry. `patch.check` now names a destructive refusal in its summary rather than reporting a generic validation failure.

Two defects were found by `sspm-scale` run 1 and are fixed:

- That fixture's first acceptance check passed on a tree Shadow had never touched. It stringified module values looking for `timeout`, and `PROJECT_ROOT` holds the workspace path, which contains the task id `config-default-timeout` — the check matched its own directory name. An acceptance check that has not been observed failing on the unmodified tree tests nothing; treat that as a rule when authoring fixtures.
- `qualityRetention` and `taskSuccessRetention` reported 0 whenever the baseline scored 0, failing Shadow for outperforming a baseline that achieved nothing. Retention is now 1 when the baseline scored nothing and Shadow scored something, and stays 0 when neither did. The paired passing `sspm-local` report reconfirmed this path: Shadow scored 100 percent while the baseline scored 0 percent, and both retention gates reported 100 percent.

#### Asserted, not verified

- **The Plan schema and prompt reductions have now run against a live provider once** in `2026-09-06-sspm-scale-shadow-audit.json`. The full Shadow-only run used 30,094 total tokens, of which 838 were frontier tokens. The run still failed, so those numbers are useful for cost shape only, not for a passing benchmark comparison.
- **Prompt caching is described as unavailable on this transport** from documented provider behaviour — automatic, no API parameter, and gated at a 1024-token prefix — not from an experiment. Nothing was measured.
- **The repository-size crossover of roughly 5 to 8 KB** is extrapolation from two points, not a measured curve. The claim that Shadow's cost stays flat as repositories grow is untested above the ~90 KB of sspm.
- **Develop's earlier large-patch failure is not the latest observed blocker.** In the saved `2026-09-06-sspm-scale-shadow-audit.json` run, both Develop patches applied cleanly, but Shadow failed because the first patch modified `core/auth.py`, `core/connectors/cloudflare.py`, and `skills/cloudflare-posture/SKILL.md`; the remediation patch then continued in `core/connectors/cloudflare.py`. The acceptance check found no timeout setting in `core/config.py`, and the scope check rejected all changed files as irrelevant.
- **The first passing real-repository Shadow-only run is saved at `2026-09-06-sspm-scale-shadow-pytest-unavailable.json`.** It completed with criteria 1/1, 100 percent task completion, zero irrelevant files loaded, zero retries, and 4,911 total tokens. Changed files were exactly `core/config.py`. Stage shape was Plan -> Develop -> Test -> Validate: Plan used 1,004 frontier tokens, Develop used 3,907 balanced tokens, Test skipped because no repository test command was configured after missing pytest was classified as unavailable infrastructure, and Validate completed with no secrets or dependency findings. Design did not run, which is correct for this deliberately narrow one-file task and should be treated as a positive routing signal rather than a missing benchmark exercise.
- **The previous `sspm-local` bottleneck was test-runner classification.** In `2026-09-06-sspm-scale-shadow-allowed-scope.json`, Develop selected only `core/config.py`, changed only `core/config.py`, and passed every deterministic acceptance check, but the run still ended `FAILED` because Tests MCP selected `tests/__init__.py` and `tests/test_auth.py`, then reported missing pytest (`No module named pytest`) as one failed test instead of unavailable infrastructure. That triggered needless remediation and drove the run to 14,584 total tokens despite criteria 1/1. Tests MCP now classifies that condition as `not_configured`, and the live `pytest-unavailable` run confirms the fix.
- **The saved `sspm-local` reports now show four distinct failure modes in sequence.** `2026-09-06-sspm-scale-shadow-audit.json` loaded the wrong neighborhood and edited Cloudflare/auth/docs while missing `core/config.py`; `2026-09-06-sspm-scale-shadow-affinity.json` found `core/config.py` but the Develop output was truncated at the 4,000-token ceiling; `2026-09-06-sspm-scale-shadow-context-cap.json` produced a valid timeout change but still touched `core/connectors/base.py`; `2026-09-06-sspm-scale-shadow-allowed-scope.json` produced an accepted one-file change and then failed only because missing pytest was misclassified as a code failure.
- **`doctor --probe` has live user-terminal evidence for two Google aliases.** The user-reported run showed valid configuration and credentials for OpenAI, Anthropic, and Google; `gemini-2-5-flash` and `gemini-3-1-pro-preview` both returned model output truncated by the 16-token probe ceiling. `gemini-3.8` separately returned HTTP 404 from Google's `v1beta generateContent` endpoint, so that alias is unsupported or unavailable there; the remaining Gemini aliases have not been live-probed in-repo by this shell.

Runs 1 through 4 are superseded and their headline numbers should not be quoted. Runs 6 through 9 moved every stage to `economy` or `balanced` and are not comparable with run 5 on cost. The user-terminal `gemini-openai-benchmark-frontier-9.json` run is valid for completion and criteria, but its `Frontier tokens: 0 vs ...` headline is stale accounting: Shadow calls to the same provider/model as `--benchmark-model` were not counted unless the alias was marked `reservedBudget`, and model-cost breakdowns were not recorded. `sspm-scale` run 1 produced no valid Shadow result. Run 5 remains the paired toy-fixture result whose numbers describe a working Shadow on tiny repositories: 4,839 tokens against 4,003, $0.0229 against $0.0508, 11/12 criteria for both, report PASS — and its 100 percent frontier reduction is vacuous, because no stage that called a model was mapped to the frontier tier. `2026-09-06-sspm-scale-paired-pytest-unavailable.json` is the first paired real-repository PASS and the first result that meaningfully demonstrates the token-conservation thesis at repository scale.

### Still Missing

#### Product-Critical Gaps

- The Plan stage has live evidence on `economy` for toy tasks and on `frontier` for the paired `sspm-local` task. It has never picked a wrong stage graph, and skipping Design for `config-default-timeout` is correct. Nothing yet proves Plan can add value on a Design-worthy task; a stronger model may plan more elaborately rather than less, and the toy fixtures cannot detect that.
- The Plan stage is currently configured to use `frontier`, and that must remain an operator-controlled choice. The product gap is not "never spend frontier tokens on Plan"; it is that Shadow does not yet make the cost/latency tradeoff obvious enough, provide strong low-cost defaults, or avoid unnecessary model planning work when the configured workflow permits deterministic routing. In the paired `sspm-local` pass, Plan consumed 956 frontier tokens before Develop touched one file. That is acceptable relative to the baseline's 27,971-token whole-repository call, but it should be a visible configured spend, not an invisible tax.
- `recover-contract-test` still carries an unevaluated criterion describing harness behaviour; unlike the `reject-output-delete` gap, no system-neutral check for it has been found.
- Design is reachable now that Plan can add stages, but nothing has yet observed a real plan choosing it, and its own agent remains unexercised against a live model. Keep `config-default-timeout` as the "skip Design for a narrow task" fixture, and add a separate cross-cutting real-repository task to gauge Design directly, such as enforcing the configured timeout across connector HTTP call sites without duplicating config parsing or altering auth behavior.
- New-project creation is not implemented end to end.
- Develop and Document cannot delete, rename, or produce binary changes; patch conflicts have no remediation beyond a bounded retry. Document edits only selected existing documentation files.
- The interactive terminal is a basic readline loop, not yet the intended command-line chatbox. The next implementation slice should make bare `shadow` feel like the product: show the current repository and configured stage/model map, run deterministic readiness checks before spending tokens, accept plain-text requests without forcing flags, stream compact stage progress, expose `/status`, `/models`, `/diff`, `/approve`, and `/cancel`, and summarize files changed plus token/cost usage at the end.
- The fixtures no longer discriminate on quality. In run 5 both systems passed every criterion the harness can evaluate, the only unpassed one being `recover-contract-test`'s unevaluated criterion. Acceptance and task completion are saturated at 11/12, so the Plan stage cannot show its value there however well it works — its cost, however, is fully visible. Separating the systems on correctness needs harder fixtures: multi-file changes, a task where whole-repository context actively misleads, or a decline that turns on something subtler than an explicit delete request. This is now the binding constraint on the benchmark, not the planner.

#### Configuration and First Run

- `shadow init` emits placeholder model names identical to the tier names, and `config validate` and `doctor` report such a configuration as valid. In practice this surfaced as an HTTP 404 three layers into a benchmark run. Placeholder and zero-cost detection, a trimmed generated file, one home for `approvals` (it is currently in both `config.yaml` and `policy.yaml`, and `policy.yaml` silently wins), and provider naming other than `default` are all still to do.
- `doctor --probe` sends one minimal request per distinct tier model through the real transport and reports the provider's own error, exiting non-zero if any tier is unreachable. Tiers sharing a model are probed once. This exists because a model id can be valid and still unreachable — `gpt-5.3-codex` returns HTTP 404 from `v1/chat/completions` with "Use the v1/responses endpoint instead" — and without a probe that surfaces as a wholly failed benchmark run minutes later.
- TODO: Rename and reshape CLI commands, flags, and setup-check language into brand-specific product vocabulary chosen by the repository owner, not by an implementing agent. Deterministic readiness checks still matter, but they should run before token-spending flows and support a mostly plain-text CLI chat experience; they should not become the primary product surface or force users through lots of flags/commands before Shadow is useful.

#### Routing and Token Controls

- OpenAI-compatible, Anthropic, and Google provider kinds exist. Anthropic and Google are minimal first adapters; Google has user-terminal probe evidence for `gemini-2-5-flash` and `gemini-3-1-pro-preview`, but the Codex shell used for this handoff has no provider API keys. Models served solely on `v1/responses` — `gpt-5.3-codex` among them — still need a Responses transport. Provider-specific token estimators are also missing.
- Direct stage-to-model alias mapping is implemented and first-class. Remaining routing work is richer provider capability metadata, optional catalog/preset generation outside the core config path, and escalation policy that can reason over aliases without overriding explicit stage assignments. Remediation re-enters Develop at its configured alias; nothing in the system escalates on its own.
- Prompt caching has nothing to implement on the current transport and should not be listed as pending work for it. OpenAI's chat/completions caches automatically, with no API parameter, and only for prompt prefixes of 1024 tokens or more; requests are already built static-prefix-first (system, then the variable payload), and Plan's whole input is now around 450 tokens, well under the threshold. A provider whose caching is explicit, such as Anthropic's `cache_control`, would need transport work. Model-response caching (reusing an identical completion) is separate and also unimplemented. Relevant-file summaries are not model-generated or cached.

#### Validation and Integrations

- Dependency scanning has no advisory data. License checking and dedicated scanner adapters are missing. Validate performs no model-based final diff review.
- There is no ESLint or Prettier toolchain; `pnpm lint` is the type check. Formatting, linting, packaging, link checking, and checksum actions are not registered.
- MCP is local stdio only.

#### Deployment and Distribution

- Deployment trusts locally configured command arrays; no cloud, CI/CD, hosting, or observability adapters. No Keychain storage, installer, signed distribution, upgrade/uninstall flow, or compatibility matrix. Crash recovery needs fault-injection coverage.

#### Fixture Scale

- **The `sspm-local` real-repository fixture now passes both Shadow-only and paired.** The paired run selected only `core/config.py`, changed only `core/config.py`, passed `timeout-present` plus `scope-limited`, skipped Test due unavailable pytest/test command, and completed Validate. Shadow used 5,243 total tokens against the baseline's 27,971, with 956 frontier tokens against 27,971. Remaining product work is to make this feel cheap, fast, and legible in the CLI while preserving explicit operator control over which lifecycle stages use frontier, balanced, economy, deterministic scripts, or MCP services.
- Two defects that run exposed, both fixed:
  - The fixture's acceptance check passed on a tree Shadow had never touched. It tested `'timeout' in str(value)` across `dir(core.config)`, and `PROJECT_ROOT` holds the workspace path, which contains the task id `config-default-timeout`. The check matched its own directory name. The replacement requires a timeout-named setting with a numeric default, and was verified to fail before the change and pass after. **An acceptance check that has not been observed failing on the unmodified tree tests nothing**; treat that as a rule when authoring fixtures.
  - `qualityRetention` and `taskSuccessRetention` reported 0 when the baseline scored 0, so Shadow was failed for outperforming a baseline that achieved nothing. Retention is now 1 when the baseline scored nothing and Shadow scored something, and stays 0 when neither did.
- The allowed-scope change is not a general answer to repository scale. It uses the fixture's explicit relevant-file contract to keep benchmark tasks honest and cheap. Real user requests still need better inference of allowed scope from natural language, better task decomposition, or both.


- A fixture's starting tree may now be a **Git source** — `{source, revision, exclude}` — cloned into the workspace and checked out at a pinned revision, instead of a directory committed beside the fixture. Evaluating Shadow against a repository therefore requires no copy of that repository: a fixture is a few lines of YAML whatever the repository's size, and a commit SHA is stronger provenance than the revision integer the directory form needs. The directory form remains for small hand-authored trees with no upstream, which is what the three existing fixtures are. Either way the workspace is re-initialised as a fresh repository with one commit, so a cloned repository's own history cannot be mistaken for the system's work, and the source is only ever read. Excludes match bare names at any depth and separator-bearing entries at the root.
- `fixtures/benchmarks/sspm-local/` demonstrates the Git form against `~/Dev/sspm` at a pinned SHA. Provisioning it was verified end to end: 39 files checked out, `venv` and `out` dropped, one provisioning commit, source repository untouched. Its single task targets `core/config.py`, which imports only the standard library and is therefore checkable with nothing installed. The path in it is machine-specific and is an example rather than a suite member.

- The fixture repositories are 352 to 677 bytes each — the whole `python-cli` repository is roughly 88 tokens. The baseline's supposed disadvantage is that it loads the entire repository; at this scale that costs it almost nothing, while Shadow pays a fixed per-task overhead of about 1,200 tokens for planning and stage plumbing. Shadow therefore cannot be cheaper on these fixtures under any tier configuration, and paired run 10 measured exactly that: 9,712 tokens against 3,741, $0.0650 against $0.0455, while winning on acceptance at 91.7 percent against 83.3 percent.
- The crossover is a repository of roughly 5 to 8 KB, above which the baseline's whole-repository load exceeds Shadow's bounded selection plus overhead. Every fixture is 10 to 20 times below it. The token-conservation thesis is untestable here, in the same way and for the same reason that the quality thesis is.
- `~/Dev/sspm` was surveyed as a candidate body: 29 tracked files, 90 KB, roughly 22,500 tokens if fully loaded, mostly Python with a real module structure. Its own test suite is unusable as a fixture — it needs `pytest`, `requests`, and live provider credentials — but `core/model.py` and `core/config.py` import with the standard library alone and could carry a stdlib `unittest` check. Vendoring a snapshot of a private security repository into `fixtures/` is a decision for the repository owner, not a mechanical step.

#### Evaluation Gaps

- `recover-contract-test` still carries one unevaluated criterion, "Compact test failure evidence returns to Develop". It describes harness behavior rather than a task outcome, and scoring it would bias retention toward Shadow; it needs rewording or removal.
- No benchmark currently proves that Design adds value. The suite needs an explicit Design-worthy fixture with checks for stage selection (`design, develop, test, validate`), compact design artifacts, Develop following the design boundary, and avoiding unrelated auth/docs/posture edits.
- Provisioned workspaces are only hermetic when the work root is outside the project; this is warned about, not solved.
- `safetyAssertions` remain descriptive. End-to-end coverage is missing for new-project creation, token-budget approval, Tests MCP outage during a run, dangerous ad hoc command rejection, and installation on a clean Mac.

### Highest-Priority Next Step

Start the command-line chatbox product slice. The core product should let a developer type `shadow` in a repository, see a concise readiness/configuration status, and then describe work in plain English without learning benchmark commands, stale tier vocabulary, or a pile of flags.

Immediate next step: inspect the current readline interactive implementation in `packages/shadow/src/cli/`, then implement the first usable `shadow` chat loop: startup banner with workspace and configured stage aliases, deterministic preflight summary before any model call, plain-text request handling through the existing orchestrator, compact live progress, and minimal slash commands for status, models, diff, approvals, cancellation, and exit. Keep benchmark runs as regression checks after this slice, not as the next driver of work.
