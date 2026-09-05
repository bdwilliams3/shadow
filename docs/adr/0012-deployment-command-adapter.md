# ADR 0012: Deployment Command Adapter

## Status

Accepted

## Decision

The MVP uses opt-in repository or user configuration profiles for deployment, health-check, and rollback commands. Each command is a validated argument array executed without a shell. Models cannot supply or alter these commands.

Profiles name credential environment variables but never contain credential values. The subprocess boundary inherits only Shadow's baseline environment and the explicitly named variables. Deployment output is bounded, stored as artifacts, and scrubbed of known credential values before persistence.

`deploy.execute` is a non-idempotent external-write action that performs deployment and health verification behind one approval gate. A failed deployment is not retried automatically. If health verification fails, Shadow persists an integrity-checked receipt before requesting a separate approval for `deploy.rollback`. Resume reads that receipt and does not execute the deployment command again.

Dry-run mode records the complete deployment plan without invoking either external action. A successful rollback leaves the overall run failed so an operator must review the incident.

## Consequences

- The MVP can support existing project deployment tooling without embedding provider-specific cloud logic.
- Deployment remains auditable and resumable across process restarts.
- Configured commands are trusted local policy and may have effects Shadow cannot sandbox on macOS; profiles must therefore be reviewed like executable code.
- A future constrained MCP deployment adapter can replace command profiles without changing the Deploy agent contract.
