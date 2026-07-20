# Stranger-test protocol

External engineer integrates Sutra into a sample app in **under one calendar day** using **only** the public docs site and scratch-published packages. No monorepo checkout, no Slack, no verbal handoff.

| Meta | Value |
|------|-------|
| **Protocol ID** | `PROTOCOL-A-P5-DOCSSITE-STRATEST` |
| **Module** | Docs site · Stranger test |
| **Timebox** | ≤ 8 hours wall-clock active work (one day) |
| **Success** | Smoke turn green + sync path understood from docs alone |
| **Depends on** | Site scaffold + quickstarts (implementor, conformance stub, binding certification) |

## 1. Scope

### In scope

| Step | Public artifact the stranger may use |
|------|--------------------------------------|
| Discover | Docs site home, Overview, Quickstart nav |
| Scaffold | `create-sutra` / `@moolam/create-sutra` (scratch registry or packed tarball) |
| Install | `sutra-sdk` from scratch scope only (`^0.1.0` or packed) |
| First turn | Implementor quickstart → `npm run smoke` |
| Sync | HTTP transport notes in implementor quickstart + Protocol README on the site |
| Optional stretch | Conformance stub guide; binding certification guide (not required for pass) |

### Out of scope (forbidden for the tester)

- Cloning or browsing the Sutra monorepo
- Slack / chat / email coaching from the core team
- Verbal walkthroughs or screen-share “hints”
- Internal stage docs under `docs/stages/**`
- `workspace:` protocol or path-linked packages from a team checkout

### Operator (facilitator) rules

- Observe only: no coaching mid-session.
- May answer **procedural** questions about the scratch registry URL / auth token only (not product docs).
- Docker / cloud harness (if used for sync): use `infra/docker-compose.yml` **exactly as an operator would** — no test-only backdoors.
- Every blocker is logged with severity; none waived without a fix plan or explicit **P7 deferral**.

## 2. Timebox & success criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Wall-clock | Active work ≤ **8 h** within one calendar day | Exceeds 8 h without green smoke |
| Install | `npm install` + `npm run typecheck` exit 0 | Cannot resolve `sutra-sdk` without monorepo |
| First turn | `npm run smoke` exit 0; events carry `subjectId` / `deviceId` (no utterance body) | Empty reply, crash, or missing subject scoping |
| Docs-only | Progress attributable to docs site + scratch packages | Required monorepo path or tribal knowledge |
| Sync literacy | Tester can state how to enable HTTP sync + `syncAttemptId` idempotency from docs | Cannot find sync path without coaching |
| Sovereignty | Tester uses a non-empty `subjectId`; does not paste learner content into logs | Cross-subject or plaintext content in events |

Stretch (recorded, not required for pass): run conformance stub or open binding certification guide.

## 3. Recruitment & session setup

1. Recruit an engineer who has **not** contributed to Sutra and has no prior Slack history with the team.
2. Provide only:
   - Docs site URL (or local `pnpm docs-site:build` + `docs:preview` served as “published”)
   - Scratch registry / packed tarball instructions (verdaccio, GitHub Packages test org, or `publish:pack` artifacts)
   - This protocol’s **tester brief** (§4) — not the internal stage task files
3. Agree start time; start wall-clock when the tester first opens the docs site.
4. Facilitator watches silently; logs friction in the recording template (§5) as it happens.

## 4. Tester brief (give this page only)

> Goal: Using only the Sutra docs site and the packages we published to the scratch registry, scaffold a companion, install dependencies, run one turn (`npm run smoke`), and note how you would enable sync. Budget: one working day (≤ 8 hours). Do not clone the Sutra source monorepo. Do not ask the team for doc answers — if stuck, write the blocker down and try another doc page. Use a synthetic `subjectId` (e.g. `stranger-demo`); never put real learner content in logs.

Suggested entry: **Quickstart → Implementor** on the docs site.

## 5. Recording template

Copy to a dated findings file (e.g. `FINDINGS-YYYY-MM-DD.md`) and fill during/after the session.

```markdown
# Stranger-test findings — YYYY-MM-DD

| Field | Value |
|-------|-------|
| Tester id (pseudonym) | |
| Facilitator | |
| Start (UTC) | |
| End (UTC) | |
| Active wall-clock (h) | |
| Docs site URL / revision | |
| Scratch package source | |
| Outcome | pass / fail |
| subjectId used | |
| deviceId used | |

## Timeline

| t (min) | Step | Notes |
|---------|------|-------|
| 0 | Opened docs site | |
| | Scaffold | |
| | Install | |
| | Smoke | |
| | Sync literacy check | |

## Friction log (every blocker)

| ID | Severity | Type | Symptom | Doc/page attempted | Waive? |
|----|----------|------|---------|-------------------|--------|
| F-001 | P0/P1/P2/P3 | doc-gap / dx-bug / env | | | no — fix or P7 defer |

Severity: **P0** blocks install/smoke; **P1** blocks sync literacy or sovereignty misunderstanding; **P2** confusion with workaround; **P3** polish.

## Success criteria checklist

- [ ] ≤ 8 h active
- [ ] install + typecheck green
- [ ] smoke green with subjectId events
- [ ] docs-only (no monorepo)
- [ ] sync path stated from docs
- [ ] no raw learner content in logs

## Restart / concurrency notes (if exercised)

- Restart mid-smoke: |
- Second device / second subjectId: |
- Sync replay / syncAttemptId: |

## Structured session event (facilitator)

Emit one line at session end (never include utterance bodies):

\`\`\`json
{"event":"docs_site.stranger_test","outcome":"pass|fail","subjectId":"<tester-pseudonym>","deviceId":"stranger-lab","activeHours":0,"frictionCount":0}
\`\`\`
```

## 6. Edge cases the facilitator must watch for

| Edge | What to record |
|------|----------------|
| Restart mid-operation | Did docs explain recovery? Did smoke stay idempotent? |
| Concurrent access (two devices / two shells) | Separate `subjectId`s? Shared mutable core? |
| Partial failure after durable write | Typed error vs silent hang? |
| Replayed sync | Did docs mention `syncAttemptId` idempotency? |

## 7. Handoff to triage (STRATEST-002)

- Commit the filled findings file next to this protocol.
- Do **not** close P0/P1 in this task — file them with severity for triage.
- Explicit P7 deferrals require an RFC entry id in the findings table’s Waive column.
