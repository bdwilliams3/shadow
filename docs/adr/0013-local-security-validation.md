# ADR 0013: Local Security Validation

## Status

Accepted

## Decision

Validate runs two registered, read-only security actions after repository changes.

`security.secrets` reuses Shadow's Git-aware repository discovery and bounded file reads. It detects a conservative set of high-confidence provider tokens and private-key headers plus warning-level credential assignments. Findings contain only rule identifier, relative path, line number, and severity. Matched values and source excerpts are never returned or persisted. High-confidence findings fail validation; warning-level findings remain open risks.

`security.dependencies` parses `package.json` through JSON and Zod. It fails malformed manifests and warns about unbounded versions, direct remote sources, and missing lockfiles. The action is network-free and reports `advisoryDatabase: not_checked`; it must not be presented as a vulnerability audit.

Both actions honor Git ignore rules and Shadow workspace exclusions. Raw file contents do not enter model context through either action.

## Consequences

- Common credential leaks and dependency-integrity mistakes are caught before completion without model tokens or network access.
- False-positive-prone generic assignments do not block a run automatically.
- Vulnerability coverage remains incomplete until an advisory-backed package-manager or MCP adapter is configured.
- Additional ecosystems require structured manifest parsers or native package-manager adapters rather than ad hoc line splitting.
