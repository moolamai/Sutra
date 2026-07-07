# Sutra Governance

This document describes how the Sutra project makes decisions, who holds which responsibilities, and how contributors grow into maintainers. It exists so that authority in the project is legible: anyone can read this file and know how a change of any size gets decided.

## Principles

1. **Contracts over code.** The wire contract and the cognitive contracts are the product; the reference implementations are replaceable. Governance weight follows that priority.
2. **Public by default.** Design discussion, RFCs, and decisions happen in public issues and discussions. Private channels are for security reports and conduct matters only.
3. **Earned authority.** Roles are granted based on a sustained record of quality contributions and sound judgment, not affiliation. Moolam AI stewards the project but does not bypass the process it set.
4. **Sovereign mission.** Decisions weigh the initiative's mission: self-hostable, offline-capable, auditable infrastructure with Indian languages as first-class citizens. Proposals that erode sovereignty properties carry a high bar.

## Roles

### Contributors

Anyone who submits an issue, PR, review, or discussion post. No approval needed. Rights: everything public. Expectations: follow the Code of Conduct and contribution guidelines.

### Triagers

Contributors granted issue-management rights: labeling, closing duplicates, requesting reproductions, shepherding `good first issue` candidates.

Path: a record of consistently helpful issue participation; nominated by any maintainer, confirmed by two.

### Maintainers

Hold merge rights over one or more areas:

| Area | Scope |
|---|---|
| `protocol` | `packages/sync-protocol`, cross-language CRDT parity |
| `contracts` | `packages/contracts`, `packages/cognitive-core`, `packages/sdk`, interface obligations |
| `edge` | `packages/edge-agent`, runtime adapters |
| `cloud` | `packages/cloud-orchestrator` |
| `playground` | The developer console, examples, and benchmarks |
| `docs` | `docs/`, top-level markdown |
| `community` | Templates, onboarding, conduct process |

Responsibilities: review within their area, uphold testing and parity requirements, shepherd RFCs, mentor contributors. Maintainers are listed in `.github/CODEOWNERS`.

Path: sustained (typically 3+ months) high-quality contributions in an area; nominated by an existing maintainer, confirmed by a majority of maintainers, no steering-council veto within 7 days.

### Steering Council

3 to 7 members responsible for direction and arbitration. Seats are held by individuals, not companies; Moolam AI appoints the initial council and holds a minority of seats as the community matures (target: community-majority council by Stage 3).

Responsibilities: roadmap stage sign-off, RFC tie-breaking, maintainer confirmation, license/trademark decisions, Code of Conduct enforcement appeals.

## Decision-making

| Decision | Mechanism |
|---|---|
| Ordinary PRs | 1 maintainer approval in area; lazy consensus |
| Wire contract or cognitive contract changes | RFC (7-day discussion + 72h final comment) + 2 maintainer approvals |
| PRD spec additions/changes | Same as contract changes |
| Roadmap stage transitions | Steering council sign-off against the stage's acceptance criteria |
| New maintainers/triagers | As described under Roles |
| Deadlocks and escalations | Steering council simple majority; written rationale required |

**Lazy consensus** is the default: silence after adequate notice is assent. Objections must be actionable ("this breaks X because Y"), not preferences.

**RFC outcomes are recorded permanently.** Declined RFCs keep their rationale so future contributors do not relitigate settled questions without new information.

## Releases and versioning

- The wire contract and cognitive contracts follow semantic versioning with an **additive-only** rule on the wire format (PRD SYNC-01).
- Reference implementations version independently of the contracts they implement.
- Release notes enumerate every accepted RFC implemented in the release.
- From Stage 3, contract 1.0 freezes: breaking changes require a new major protocol version with a published migration path and long overlap support.

## Changes to this document

Governance changes follow the RFC process with a 14-day discussion window and steering council confirmation.

## Conduct and security

- Code of Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Enforcement by the community maintainers; appeals to the steering council.
- Security policy: [`SECURITY.md`](SECURITY.md). Coordinated disclosure only.
