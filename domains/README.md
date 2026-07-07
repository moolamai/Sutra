# Domains

Domain modules live here, outside the infrastructure packages. A domain is *configuration plus corpora plus tool packs*, never new cognitive machinery: it binds the contracts from `@moolam/contracts`, authors a profile (charter, refusals, languages), supplies a task graph, and registers tools. The cognitive loop it runs is the same one every other domain runs.

## The dependency rule

Domains depend on infrastructure. Infrastructure never depends on domains.

- No package under `packages/` may import from `domains/`.
- No domain may import from another domain.
- The cloud engine loads domain artifacts (task graphs, charters, tool descriptors) as data, not as code paths.

CI enforces the vocabulary side of this rule: profession-specific terms stay out of `packages/`.

## Available domain specifications

| Domain | Companion | Status |
|---|---|---|
| [`teacher/`](teacher/README.md) | Autonomous cognitive teacher | Reference domain; the demo task graph and Playground use it |
| [`lawyer/`](lawyer/README.md) | Autonomous legal companion | Specification |
| [`doctor/`](doctor/README.md) | Clinical cognitive assistant | Specification |
| [`engineering/`](engineering/README.md) | Engineering design companion | Specification |
| [`finance/`](finance/README.md) | Financial analyst companion | Specification |

## Anatomy of a domain

Every domain directory contains the same five documents:

| File | Answers |
|---|---|
| `README.md` | What this companion is, who it serves, its safety posture |
| `interfaces.md` | Which implementation to bind behind each contract, and the profile to author |
| `memory.md` | What the memory kinds mean in this domain and what must never decay |
| `tools.md` | The tool pack with risk classes and approval policy |
| `workflows.md` | The domain's task graphs and how guidance modes map to its practice |

## Adding a domain

1. Copy the five-file structure from the closest existing domain, or start from [`examples/custom-domain/`](../../examples/custom-domain/README.md) for a runnable adapter skeleton.
2. Author the profile, task graph, and tool descriptors; bind connectors.
3. Add a runnable example under `examples/` (see `teacher-basic/` and `lawyer-basic/`).
4. Open a domain configuration issue or PR; the RFC process is only needed if the contracts themselves must change (they usually must not).
