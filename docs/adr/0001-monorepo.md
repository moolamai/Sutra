# ADR 0001: One monorepo for contracts, core, hosts, and domains

Status: Accepted

Date: 2026-07

## Context

The platform spans two languages (TypeScript for contracts, core, edge; Python for the cloud engine), a wire protocol that both must implement identically, and domain specifications that must track the contracts. Drift between these pieces is the primary failure mode: a protocol field renamed on one side silently breaks sync.

## Decision

A single monorepo managed with pnpm workspaces and Turborepo, containing all packages, the cloud engine, domains, examples, benchmarks, and documentation. Cross-language contract parity is enforced by smoke tests that run fixtures through both implementations in one CI pass.

## Options considered

- **Polyrepo per package**: cleaner ownership boundaries, but contract drift becomes an integration-time discovery and atomic cross-package changes require coordinated releases. Rejected for a pre-1.0 platform where contracts still move.
- **Monorepo without workspace tooling**: simpler, but rebuild times and dependency hygiene degrade as packages multiply. Rejected.
- **Monorepo (chosen)**: one PR can change a contract, both implementations, the tests, and the docs atomically.

## Consequences

- Contract changes are atomic and reviewable in one diff; CI validates both languages together
- Contributors need pnpm and Python locally for a full check, though per-package work stays isolated
- Repository size grows with domains and examples; acceptable because they are text
- If the project later needs independent release cadences per package, changesets can be layered on without restructuring
