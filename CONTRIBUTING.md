# Contributing to Sutra

Thank you for considering a contribution to Sutra, the open infrastructure for autonomous cognitive companions under the Indian Sovereign AI Initiative. This document explains how to be part of the initiative: how the project is organized, how to set up a development environment, how to find work that matters, and how changes get reviewed and merged.

Sutra is built by Moolam AI together with its community. Contributions of every kind are valued: code, documentation, task graphs, knowledge connectors, domain specifications, language support, evaluation studies, bug reports, and design review.

---

## Table of contents

1. [Ways to be part of the initiative](#1-ways-to-be-part-of-the-initiative)
2. [Project structure](#2-project-structure)
3. [Development environment setup](#3-development-environment-setup)
4. [Finding work](#4-finding-work)
5. [Development workflow](#5-development-workflow)
6. [Coding standards](#6-coding-standards)
7. [Testing requirements](#7-testing-requirements)
8. [Commit and PR conventions](#8-commit-and-pr-conventions)
9. [The RFC process for protocol and interface changes](#9-the-rfc-process-for-protocol-and-interface-changes)
10. [Documentation contributions](#10-documentation-contributions)
11. [Domain configurations: curricula, connectors, tools](#11-domain-configurations-curricula-connectors-tools)
12. [Language and localization](#12-language-and-localization)
13. [Review process and merge criteria](#13-review-process-and-merge-criteria)
14. [Community channels and getting help](#14-community-channels-and-getting-help)

---

## 1. Ways to be part of the initiative

You do not need to be a systems programmer to contribute meaningfully.

| You are | High-impact contributions |
|---|---|
| **TypeScript/Python engineer** | Interface conformance suites, CRDT property tests, SLM runtime adapters, speech/vision bindings, tool policy engine |
| **ML/AI practitioner** | Reasoning engine implementations, friction-model calibration, evaluation harnesses, on-device quantization recipes |
| **Domain expert (law, medicine, finance, engineering)** | Domain goal graphs, refusal boundary reviews, knowledge connector specifications, regulated-deployment guides |
| **Educator** | Prerequisite task graphs for education, guidance review of the task router, pilot feedback |
| **Linguist / native speaker** | Indic language coverage for speech and text, translation review, voice evaluation |
| **Technical writer** | Documentation, tutorials, integration guides, API references |
| **Designer** | Playground UX, accessibility passes, data-visualization patterns for cognitive telemetry |
| **Anyone** | Bug reports with reproductions, documentation fixes, triaging issues, answering questions |

If you are unsure where you fit, open a discussion thread introducing yourself and what you want to work on. A maintainer will help you find a first task.

## 2. Project structure

```
sutra/
├── packages/
│   ├── contracts/            # Pure cognitive + runtime interfaces (dependency root)
│   ├── cognitive-core/       # The CognitiveCore composition loop
│   ├── runtime/              # Lifecycle host, scheduler, event bus
│   ├── sync-protocol/        # The wire contract + CRDT merge engine (TS)
│   ├── telemetry/            # Friction collector shared by edge and cloud
│   ├── edge-agent/           # Offline-first on-device host (TS)
│   ├── cloud-orchestrator/   # FastAPI + LangGraph reference engine (Python)
│   └── sdk/                  # The one public entry point
├── domains/                  # Domain specifications: teacher, lawyer, doctor, engineering, finance
├── examples/                 # Runnable scripts against the SDK
├── benchmarks/               # Microbenchmarks
├── playground/               # Next.js developer console
├── design/                   # Implementation philosophy per subsystem
├── rfcs/                     # Accepted design proposals + template
├── infra/                    # docker-compose self-host stack
├── docs/                     # Layered docs, ADRs, OVERVIEW, PRD_MATRIX, ROADMAP (internal: stages, Dev Framework — gitignored)
└── .github/                  # Issue templates, PR template, CI
```

Two centres of gravity govern everything:

- **The wire contract** (`packages/sync-protocol/src/contract.ts`): every byte crossing the edge/cloud boundary.
- **The cognitive contracts** (`packages/contracts/src/`): the cognitive and runtime primitives every package is built from.

Changes to either require an RFC (see section 9). Everything else follows the normal PR flow.

## 3. Development environment setup

### Prerequisites

- Node.js >= 22
- pnpm >= 10 (`corepack enable` or `npm i -g pnpm`)
- Python >= 3.12
- Docker (only for the full self-host stack; not needed for most contributions)

### Setup

```bash
git clone https://github.com/moolamai/sutra.git
cd sutra
pnpm install                     # installs all workspace packages
pnpm build                       # builds contracts → sync-protocol → core/runtime/telemetry → edge-agent → sdk → playground

# Python engine (optional, for cloud-orchestrator work)
cd packages/cloud-orchestrator
pip install -e ".[dev]"
```

### Verify your setup

```bash
pnpm typecheck                                        # all TS packages
node packages/sync-protocol/smoke_test.mjs            # CRDT algebra (TS)
python packages/cloud-orchestrator/smoke_test.py      # CRDT algebra (Python)
pnpm --filter @moolam/playground dev                  # console at http://localhost:3000
```

If all four succeed, you are ready.

### Full stack (optional)

```bash
pnpm infra:up      # Postgres+pgvector, Redis, orchestrator on :8000
pnpm infra:down
```

## 4. Finding work

- **`good first issue`** label: scoped tasks with clear acceptance criteria, suitable for a first PR.
- **`help wanted`** label: maintainer-validated tasks open to anyone.
- **`rfc-accepted`** label: approved designs awaiting implementation, the highest-impact code work.
- **Stage criteria in [`docs/ROADMAP.md`](docs/ROADMAP.md)**: any unchecked box is open work; comment on or open a tracking issue before starting large items.
- **Conformance gaps**: the obligations tables in [`docs/sdk/INTERFACES.md`](docs/sdk/INTERFACES.md) that lack tests are standing work items.

Before starting anything larger than a small fix, open or claim an issue and state your approach. This prevents duplicated effort and lets maintainers flag design constraints early.

## 5. Development workflow

1. **Fork** the repository and create a topic branch from `main`:
   `git checkout -b feat/speech-partial-transcripts`
2. **Make focused changes.** One logical change per PR. If you find unrelated problems, file issues instead of bundling fixes.
3. **Add or update tests** (see section 7). PRs that reduce coverage of contract obligations are not mergeable.
4. **Run the full local gate** before pushing:

```bash
pnpm build && pnpm typecheck
node packages/sync-protocol/smoke_test.mjs
python packages/cloud-orchestrator/smoke_test.py
```

5. **Push and open a PR** against `main` using the PR template. Link the issue it resolves.
6. **Respond to review.** Reviews are about the code, never the person; expect the same standard in your replies.

### Branch naming

| Prefix | Use |
|---|---|
| `feat/` | New functionality |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `test/` | Test additions/refactors |
| `rfc/` | RFC implementation branches |
| `chore/` | Tooling, CI, dependencies |

## 6. Coding standards

### TypeScript (contracts, core, runtime, protocol, edge, playground)

- Strict mode is non-negotiable; the base tsconfig enables `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Do not weaken compiler options.
- Interfaces over implementations in `contracts`: the contracts package MUST NOT import vendor SDKs, database drivers, or model runtimes; it has zero runtime dependencies. Adapters live in separate packages.
- Every exported symbol carries JSDoc explaining intent and contract obligations, not restating the signature.
- No `any` outside test fixtures; prefer `unknown` + narrowing.
- Runtime validation with Zod at every boundary where external data enters.

### Python (cloud-orchestrator)

- Python 3.12+, full type annotations, `mypy --strict` clean.
- Pydantic models mirror the TS contract field-for-field; if you touch one side you MUST touch the other and say so in the PR.
- Docstrings on every public module, class, and function; document the "why" and the contract, not the obvious.
- `ruff` for lint/format (config in `pyproject.toml`).

### Both languages

- The CRDT implementations must remain twins. Any change to merge semantics requires the same change in both languages plus updated smoke/property tests proving identical joins.
- No silent behavior. Errors are typed and surfaced; degradations produce advisories; plans and conclusions carry rationales. This is a platform for regulated domains; auditability is a feature, not overhead.
- Comments only where code cannot speak: invariants, trade-offs, protocol references (e.g. `per SYNC-03`).

## 7. Testing requirements

| Change type | Required tests |
|---|---|
| Contract/wire format (additive only) | Zod + Pydantic schema tests, cross-language serialization round-trip |
| CRDT merge semantics | Property tests in BOTH languages: commutativity, associativity, idempotence, plus the specific scenario |
| Contract obligations | Conformance test exercising the obligation (e.g. durable-before-resolve, empty-trace rejection, citation presence) |
| Adapters/bindings | Unit tests against the interface contract + integration test with a real or faked backend |
| Cloud engine routing | Router scenario tests: advance, hold, loop-back, depth breaker, mode hysteresis |
| Playground | Typecheck + production build must pass; interaction logic covered by component tests where present |
| Docs | Links resolve; code samples compile/run |

Bug-fix PRs MUST include a test that fails without the fix. If a bug cannot be tested, explain why in the PR.

## 8. Commit and PR conventions

### Commit messages

Follow Conventional Commits:

```
<type>(<scope>): <imperative summary ≤ 72 chars>

<body: what and why, wrapped at 100 chars>

Refs: #123
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`.
Scopes: `contracts`, `core`, `runtime`, `protocol`, `telemetry`, `edge`, `cloud`, `sdk`, `domains`, `examples`, `playground`, `infra`, `docs`.

Examples:

```
feat(contracts): add streaming partial results to VisionInterface
fix(protocol): clamp HLC logical counter overflow at 999999
docs(domains): add agronomy connector specification
```

### Pull requests

- Fill in every section of the PR template; "N/A" with a reason is acceptable, blank is not.
- Keep PRs under ~500 changed lines where possible; split larger work into reviewable stages behind a tracking issue.
- PRs touching both languages' CRDT code must state the parity check performed.
- Screenshots or terminal captures for anything user-visible (Playground, CLI output).
- CI must be green before review is requested.

## 9. The RFC process for protocol and interface changes

The wire contract and the cognitive contracts are load-bearing for every downstream implementation. Changes to them follow a Request-for-Comments process, like Rust's or Python's PEPs, scaled to this project. The template and accepted proposals live in [`rfcs/`](rfcs/README.md).

**RFC is required for:**

- Any change to `packages/sync-protocol/src/contract.ts` beyond documentation
- Any change to the contract files in `packages/contracts/src/`
- New MUST-level obligations, or relaxation of existing ones
- New top-level spec IDs in `docs/PRD_MATRIX.md`

**RFC is NOT required for:** adapters, bindings, docs, tests, domain specifications, examples, Playground features, bug fixes that restore documented behavior.

**Process:**

1. Open an issue using the **RFC template**. It asks for: motivation, detailed design, contract/obligation changes, cross-language impact, migration for existing implementations, alternatives considered, and unresolved questions.
2. Discussion happens on the issue for a minimum of **7 days**. Maintainers may request a prototype branch.
3. A maintainer moves the RFC to `rfc-final-comment` for a further **72 hours**.
4. Outcome recorded on the issue: `rfc-accepted` (implementation may begin, tracked by the issue) or `rfc-declined` (with written rationale, kept for the record).
5. Accepted RFCs land as numbered documents in `rfcs/` and are summarized in the protocol changelog when implemented.

Wire-format changes are **additive-only** at every stage; nothing is ever removed or repurposed on the wire. See PRD SYNC-01.

**Protocol changelog:** when an accepted RFC (or other wire edit) lands in code,
add a bullet under `## [Unreleased]` in
[`packages/sync-protocol/CHANGELOG.md`](packages/sync-protocol/CHANGELOG.md)
in the same PR. Do not invent a version section until release cut. The **0.1.0**
baseline documents the full initial wire surface.

## 10. Documentation contributions

Documentation lives in `docs/` and package `README`s. High-value contributions:

- Integration tutorials ("build a voice companion in 30 minutes")
- Reference-binding guides per interface
- Deployment runbooks for self-hosting
- Translations of `docs/OVERVIEW.md` into Indian languages (open an issue first so we can set up the structure properly)

Style: plain sentences, no hype, no em dashes, explain jargon on first use, prefer tables for enumerable facts. Every claim about system behavior must be true of the code as merged, not aspirational; aspirations belong in the roadmap.

## 11. Domain configurations: task graphs, connectors, tools

The platform grows through domain configurations more than through platform code. Domain specifications live in [`domains/`](domains/README.md); each one is five documents (README, interfaces, memory, tools, workflows) plus artifacts. These are first-class contributions:

- **Task graphs**: prerequisite DAGs with success criteria, validated against the router. Start from `demo_task_graph()` in `task_router.py`.
- **Knowledge connectors**: implementations of `KnowledgeConnectorInterface` for open corpora (legislation, clinical guidelines, standards, textbooks). Every passage must carry a resolvable citation and truthful as-of date.
- **Tool packs**: schema'd tools with honest risk classes. Anything marked `read`/`compute` must be genuinely side-effect free.
- **Agent profiles**: charters and refusal boundaries for a domain, reviewed by at least one practitioner of that domain before merge.
- **New domain specifications**: copy the five-file structure from the closest existing domain and pair it with a runnable example under `examples/`.

Domain configurations targeting regulated fields (law, medicine, finance) additionally require a practitioner reviewer and an explicit scope-of-practice statement in the PR.

## 12. Language and localization

Sovereign reach means Indic languages are first-class, not afterthoughts:

- Speech bindings: STT/TTS adapters for Hindi, Tamil, Telugu, Bengali, Marathi, Kannada, and beyond; report `supportedLanguages` truthfully.
- Evaluation: native-speaker review of guidance quality, voice naturalness, and register appropriateness (a companion for children speaks differently from one for advocates).
- Terminology: glossaries mapping protocol terms to Indian-language documentation.

If you are a native speaker willing to review even one language, that is a valuable standing contribution; say so in an issue.

## 13. Review process and merge criteria

- Every PR needs approval from at least **one maintainer**; wire-contract and cognitive-contract changes need **two** plus an accepted RFC.
- Reviewers check, in order: correctness against the contracts and PRD spec IDs, test adequacy, cross-language parity where applicable, docs updated, no scope creep.
- Expect first review within a few days. Politely ping after 7 days of silence.
- Maintainers may commit small fixups to your branch to unblock a merge; you remain the author.
- Merges are squash-merges; the PR title becomes the commit subject, so keep it in Conventional Commit form.

## 14. Community channels and getting help

- **GitHub Discussions**: design questions, ideas, introductions, show-and-tell.
- **GitHub Issues**: bugs and actionable work only; questions go to Discussions.
- **Security issues**: never public; see [`SECURITY.md`](SECURITY.md).
- **Conduct concerns**: see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Decision-making, maintainer roles, and how to become a maintainer are documented in [`GOVERNANCE.md`](GOVERNANCE.md).

---

By contributing, you agree that your contributions are licensed under the repository's [Apache-2.0 license](LICENSE). Sutra uses the Developer Certificate of Origin (DCO): sign your commits with `git commit -s` to certify you have the right to submit the work.
