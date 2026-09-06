# ADR 0017: Model-Backed Plan Stage And Graph Revision

## Status

Accepted

## Context

Plan was the last lifecycle stage with no model behind it. It ran `repository.inspect`, returned three fixed strings, and the stage graph was chosen by four regexes over the lowercased request. Three consequences followed: stage tasks carried no acceptance criteria, `agents.plan: frontier` had no effect, and Shadow's headline benchmark number — a 100 percent frontier-token reduction — measured nothing, because no stage that called a model was mapped to the frontier tier.

The blocking problem was structural rather than a matter of prompting. `run.stageTasks` was fixed at the `PLANNED` transition, before any stage executed, so no stage result could influence what ran afterwards.

## Decision

### Revision as a stage result

`StageResult` carries an optional `planRevision`. The orchestrator applies it after the Plan stage records a completed result, rewriting only `run.stageTasks` and `run.stageRuns` after the current index. The field is optional so results persisted before this change still parse.

A revision is a proposal, not an instruction. The plan decides two things: which stages run, and what done means for each. Everything governing cost or blast radius stays with configuration and the stage table — enablement, canonical ordering, allowed tools, write permissions, and the ceiling on capability tier. Stages at or before the current index have already executed and are never touched, so a revision cannot rewrite history or re-run completed work. A stage that survives a revision keeps its task id, which keeps resume, approvals, and remediation-cycle bookkeeping coherent.

`allowedToolsFor` and `writePermissionsFor` moved into `planner.ts` as the single authority used by both the deterministic bootstrap and the applier, so the two cannot drift.

### Tier recommendations are downgrade-only

A plan may recommend a capability tier per stage. It is honoured only at or below the tier configuration assigns that stage; an escalation is recorded as an open risk and refused. Configuration stays the authority on spend, so no model can quietly make a run more expensive. This is the §9 escalation policy's "never escalate beyond the run budget without user approval" expressed as a mechanism rather than a prompt.

### Acceptance criteria are bounded and scoped

Criteria are capped at four per stage and attached only to Design, Develop, and Document; deterministic stages receive none regardless of what the plan returns. The cap and the filter are enforced in code, not requested in the prompt.

This is a direct response to a recorded failure. When the planner's four run-level invariants were handed to Develop as acceptance criteria, a live model declined an ordinary two-file edit for lacking "orchestration, persistence, budgeting, and policy-evaluation components". Criteria that describe the harness rather than the user's change turn an ordinary edit into a specification the model would rather refuse than satisfy. The prompt says so explicitly; the cap ensures a verbose plan cannot recreate the failure by volume.

### Planning failure falls back, approval does not

An unreachable provider, a budget refusal, or a plan naming no runnable stage leaves the deterministic bootstrap graph in place, completes the Plan stage, and records a visible risk. Planning improves the lifecycle; it is not a precondition for it, and one flaky provider call should not cost the user the run.

A `ModelRoutingError` carrying `approvalRequired` is the exception: it returns `blocked` so the existing approval pause surfaces. An approval is a decision the user still has to make, not a failure to route around.

Because Plan runs while the run is still in `PLANNED`, `PLANNED -> AWAITING_APPROVAL` was added to the state machine. Plan is the first stage that can pause for approval before the run reaches `EXECUTING`.

## Consequences

The frontier tier is live for the first time, and the benchmark's central ratio now measures a real quantity. It is not yet a favourable one: on the synthetic single-task executor fixture, routing Plan to frontier costs 122 frontier tokens against the baseline's 120 — a reduction of −1.7 percent, where the number was previously a vacuous 100 percent. Plan buys acceptance criteria, a graph chosen by a model rather than by regex, and a tier recommendation; on a one-file fixture it does not buy enough to pay for itself. Harder fixtures are the outstanding work, not a cheaper planner.

`shadow models` now annotates Test, Validate, and Deploy as deterministic, because a tier mapped to them is inert.

### Bring-up window

`.shadow/config.yaml` pins every agent to the `economy` tier and intentionally diverges from the §9 mapping that `src/config/defaults.ts` still carries. The Plan stage must produce correct stage graphs and acceptance criteria across several passing benchmark runs before any stage is allowed to spend frontier tokens. Pinning Plan alone would not be enough: a plan revision can add stages, so Design or Document on a higher tier would reintroduce the spend by the back door. A regression test asserts that a fully-economy agent mapping yields zero frontier tokens for Shadow.

The single-frontier baseline is unaffected by the agent mapping — it resolves `models.frontier` directly, by design — so a benchmark run that includes it still spends frontier tokens. `--system shadow` excludes it during bring-up.

Restoring the spec mapping is one deliberate change, and it is the change that makes the frontier-reduction gate meaningful.
