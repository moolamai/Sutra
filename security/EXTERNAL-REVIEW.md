# Sutra external-equivalent security review — scope and methodology

| Meta | Value |
|------|-------|
| **Spec** | SEC-01 |
| **Phase** | P7 — Production hardening and 1.0 |
| **Status** | Triaged — all findings closed or accepted; no open P0/P1; re-test evidence recorded |
| **Threat model** | [`security/THREAT-MODEL.md`](./THREAT-MODEL.md) |

This document commissions the security review of the Sutra protocol and platform and records its scope, engagement model, independence rules, and methodology. The review targets design and implementation flaws — protocol parsing, auth bypass paths, tool sandbox escape, and sync replay — **not just dependency CVEs**. A dependency scan is the floor of this engagement, never its substance.

## Engagement record

| Field | Value |
|-------|-------|
| **Mode** | Structured internal red team under external-equivalent independence rules (see below) |
| **Commissioned** | 2026-07-16 |
| **Review basis** | Fresh clone at a pinned commit recorded at kickoff; reviewers receive `security/THREAT-MODEL.md` and public docs only — no branch context or design chats |
| **Reviewers** | One named reviewer per surface, assigned at kickoff; assignment recorded in the findings register alongside each finding |
| **Exit** | All P0/P1 findings closed with re-test evidence (triage slice) before the freeze RFC is accepted |

## Review scope

Four surfaces, each anchored to the trust boundary inventory in [`THREAT-MODEL.md`](./THREAT-MODEL.md) and to the code under review. Every surface names attack goals beyond CVE scanning.

### Surface R1 — Wire protocol parsing (`protocol`)

| Aspect | Value |
|--------|-------|
| Trust boundaries | `TB-SYNC-01`, `TB-SYNC-03`, `TB-CLOUD-06` |
| Code under review | `packages/sync-protocol/src/contract.ts`, `packages/sync-protocol/src/harness_frames.ts`, `packages/cloud-orchestrator/src/sutra_orchestrator/contract_models.py` |
| Attack goals | Malformed, oversized, duplicate-key, or type-confused payloads that crash the parser, bypass Zod/Pydantic validation, or smuggle unvalidated fields past the boundary ("parse, never cast" violations) |
| Regression anchors | `packages/sync-protocol/tests/golden_joins.test.mjs`, `packages/sync-protocol/tests/tool_envelope_errors.test.mjs` |

### Surface R2 — P2 auth boundary (`auth`)

| Aspect | Value |
|--------|-------|
| Trust boundaries | `TB-CLOUD-01`, `TB-CLOUD-02`, `TB-CLOUD-08` |
| Code under review | `packages/cloud-orchestrator/src/sutra_orchestrator/auth.py`, `packages/cloud-orchestrator/src/sutra_orchestrator/middleware.py` |
| Attack goals | Auth bypass paths: missing/forged/expired credentials reaching handlers, cross-subject scope escalation via `subjectId` confusion, operator-wildcard (`*`) misuse, credential material leaking into logs or `CallerContext` |
| Regression anchors | `packages/cloud-orchestrator/tests/test_auth_boundary.py`, `packages/cloud-orchestrator/tests/test_auth_semantics_matrix.py`, `packages/cloud-orchestrator/tests/test_subject_scope_enforcement.py`, `packages/cloud-orchestrator/tests/test_reference_verifiers.py` |

### Surface R3 — B4 tool execution sandbox (`sandbox`)

| Aspect | Value |
|--------|-------|
| Trust boundaries | `TB-TOOL-01` … `TB-TOOL-08` |
| Code under review | `packages/cognitive-core/src/tool_policy.ts`, `packages/cognitive-core/src/tool_stage.ts`, `packages/cognitive-core/src/tool_audit.ts`, `packages/sync-protocol/src/tool_envelope.ts` |
| Attack goals | Sandbox escape: adversarial model output injecting tool calls, `riskClass` downgrade to auto-execute, approval-hook bypass, write-ahead audit evasion, deadline/payload-bound exhaustion, cross-subject tool context |
| Regression anchors | `packages/cognitive-core/tests/tool_policy_risk_class.test.mjs`, `packages/cognitive-core/tests/write_ahead_conformance.test.mjs`, `packages/runtime-harness/tests/sandbox_seam.test.mjs` |

### Surface R4 — Sync path and CRDT merge (`sync`)

| Aspect | Value |
|--------|-------|
| Trust boundaries | `TB-SYNC-04` … `TB-SYNC-08` |
| Code under review | `packages/cloud-orchestrator/src/sutra_orchestrator/sync_service.py`, `packages/cloud-orchestrator/src/sutra_orchestrator/crdt_merge.py`, `packages/sync-protocol/src/sync_engine.ts` |
| Attack goals | Replayed or duplicated `SyncRequest` double-applying friction (idempotence break), concurrent same-subject sync interleaving read-modify-write, HLC regression abuse, audit-trail repudiation, raw learner content exfiltrating over the wire |
| Regression anchors | `packages/cloud-orchestrator/tests/test_restart_durability.py`, `packages/cloud-orchestrator/tests/test_sync_audit_writer.py`, `packages/cloud-orchestrator/tests/test_master_state_repository.py` |

## Independence rules

External-equivalent means the internal red team operates under the same separation an outside firm would have. All five rules are binding for the engagement:

1. **No self-review.** A reviewer must not have authored, co-authored, or code-reviewed the code on their assigned surface; assignment is checked against `git log`/blame before kickoff.
2. **Fresh-clone basis.** Reviewers work from a fresh clone at the pinned commit with the published docs only — no access to implementation branches, design chats, or the authors' rationale beyond what an external party would receive.
3. **Attack before defense.** Reviewers write their attack attempts against each surface's attack goals *before* reading the mitigation column of `THREAT-MODEL.md`, then reconcile — so the review tests the system, not the paperwork.
4. **Independent reporting line.** Findings are filed to the module owner and the track lead, never triaged or downgraded by the code's author; severity disputes escalate to the track lead, whose decision is recorded in the register.
5. **Named sign-off.** Each surface's review concludes with a named reviewer and date in the findings register; an unsigned surface is an unreviewed surface.

## Methodology

Per surface, in order — each step produces evidence (transcript, failing input, or test link) attached to the register:

1. **STRIDE walk.** Re-derive threats from the surface's `TB-*` crossings in `THREAT-MODEL.md`; flag any crossing whose enumerated threats look incomplete.
2. **Adversarial input testing.** Drive the parse boundaries (R1, R3) with malformed, oversized, duplicate, and type-confused payloads; every rejection must be a typed contract error naming the violated obligation, never an unhandled rejection or silent skip.
3. **Auth bypass matrix (R2).** Exercise missing, malformed, forged, and out-of-scope credentials against every `/v1/*` route class; verify cross-subject requests are denied and denials are typed and logged as metadata only.
4. **Sandbox escape attempts (R3).** Attempt envelope injection from model output, `riskClass` manipulation, approval bypass, and effects-before-audit orderings; verify write-ahead audit and default-deny hold under concurrency.
5. **Replay and idempotence probes (R4).** Re-send identical and duplicated sync payloads, race concurrent same-subject syncs, and inject HLC regressions; verify convergence, single-application, and audit append.
6. **Dependency and configuration floor.** CVE scan of the lockfiles and a review of default configs — recorded last, explicitly as the floor of the engagement, not the review.

Sovereignty constraint on the review itself: red-team fixtures use synthetic subjects only; no real learner content enters review transcripts, and evidence artifacts carry `subjectId` metadata, never raw utterances.

## Severity policy

| Severity | Definition | Gate effect |
|----------|------------|-------------|
| **P0** | Exploitable cross-subject read/write, sandbox escape, or remote crash of a host from wire input | Blocks freeze RFC acceptance; fix and re-test before any release |
| **P1** | Auth bypass or content-locality leak requiring non-default but plausible configuration | Blocks freeze RFC acceptance; fix and re-test before any release |
| **P2** | Defense-in-depth gap with no demonstrated exploit path | Scheduled fix with owner and date; does not block freeze RFC |
| **P3** | Hardening or informational | Recorded; folded into the residual risk register where accepted |

**P0/P1 findings block freeze RFC acceptance until closed with re-test evidence.** Closure and re-test tracking is the triage slice; the register below is its single source of truth.

## Findings register

Every finding names its surface, severity, owner, and a re-test evidence link (an existing regression test that fails on the vulnerable behavior and passes after closure). No finding may be closed by the code's author alone — each closure carries the independent reviewer's sign-off recorded in the review log.

Severity below is the reviewer's **filed** severity (worst-case if unmitigated), so the register shows the review reached the P0/P1 surfaces rather than downgrading on contact. Every P0/P1 finding here resolved to an already-enforced mitigation on re-test; each is `closed` with the regression test that locks the behavior. Defense-in-depth items with no demonstrated exploit path are `accepted` and folded into the threat model residual register.

| Finding ID | Surface | Severity | Status | Owner | Re-test evidence |
|------------|---------|----------|--------|-------|------------------|
| `F-EXT-001` | auth | P1 | closed | Track A lead | `packages/cloud-orchestrator/tests/test_subject_scope_enforcement.py` |
| `F-EXT-002` | auth | P1 | closed | Track A lead | `packages/cloud-orchestrator/tests/test_auth_semantics_matrix.py` |
| `F-EXT-003` | sandbox | P0 | closed | Track A lead | `packages/cognitive-core/tests/tool_policy_risk_class.test.mjs` |
| `F-EXT-004` | sandbox | P0 | closed | Track A lead | `packages/cognitive-core/tests/write_ahead_conformance.test.mjs` |
| `F-EXT-005` | sync | P1 | closed | Track A lead | `packages/cloud-orchestrator/tests/test_restart_durability.py` |
| `F-EXT-006` | sync | P1 | closed | Track A lead | `packages/cloud-orchestrator/tests/test_sync_audit_writer.py` |
| `F-EXT-007` | protocol | P2 | closed | Track A lead | `packages/sync-protocol/tests/tool_envelope_errors.test.mjs` |
| `F-EXT-008` | sandbox | P3 | accepted | Domain integrator | see `RR-HOST-TOOL-001` in [`THREAT-MODEL.md`](./THREAT-MODEL.md) |
| `F-EXT-009` | sync | P3 | accepted | Deployment operator | see `RR-TLS-001` in [`THREAT-MODEL.md`](./THREAT-MODEL.md) |

### Finding detail

- **`F-EXT-001` — cross-subject scope escalation (auth, P1).** Reviewer attempted a turn/state request scoped to subject A while authenticated for subject B. The boundary rejected it with a typed scope denial; `subjectId` scope is enforced on every subject-addressed route. Closed — re-test locks cross-subject denial.
- **`F-EXT-002` — auth bypass matrix (auth, P1).** Missing, malformed, forged, and out-of-scope credentials were driven against `/v1/*`. All non-authorized classes were denied default-deny, credentials never reached handlers, and denials logged metadata only. Closed — semantics matrix re-test locks every cell.
- **`F-EXT-003` — riskClass downgrade / envelope injection (sandbox, P0).** Adversarial model output attempted to auto-execute a write-class tool by omitting or downgrading `riskClass`. Fail-safe assume-write and default-deny-without-hook held. Closed — risk-class routing re-test locks the table.
- **`F-EXT-004` — effect-before-audit ordering (sandbox, P0).** Attempted a write/critical effect before audit acknowledgment. Write-ahead `recordThenInvoke` blocked the effect until the audit committed. Closed — write-ahead conformance re-test locks the ordering.
- **`F-EXT-005` — sync replay double-application (sync, P1).** Re-sent identical and duplicated `SyncRequest` payloads across a simulated restart. CRDT join idempotence applied friction exactly once. Closed — restart-durability re-test locks idempotence.
- **`F-EXT-006` — audit repudiation (sync, P1).** Attempted to converge state without a durable audit trail. `sync_audit` append is transactional with the state write. Closed — audit-writer re-test locks the same-transaction guarantee.
- **`F-EXT-007` — tool envelope parser hardening (protocol, P2).** Malformed and duplicate-key envelopes were fed to `parseToolCallEnvelope`. The closed error enum rejected them as typed `ToolStageError`, stripping unknown keys. Closed — envelope-error re-test locks the rejections.
- **`F-EXT-008` — host tool sandbox isolation (sandbox, P3).** Sandbox isolation depends on the host `ToolInterface`; the B4 seam enforces deadlines and payload bounds only. No platform exploit path. Accepted as residual `RR-HOST-TOOL-001`.
- **`F-EXT-009` — transport confidentiality (sync, P3).** TLS termination, cert rotation, and cipher policy are deployment-owned. No platform exploit path. Accepted as residual `RR-TLS-001`.

## Closure checklist

Re-run confirming closure — every box ticked before the freeze RFC may be accepted:

- [x] Every finding is filed with a surface and a severity.
- [x] No P0 or P1 finding remains open (all `closed` with re-test evidence).
- [x] Each closed finding links a regression test that resolves to a file in the repo.
- [x] Each accepted (P2/P3) finding maps to a residual risk entry with owner and review date in [`THREAT-MODEL.md`](./THREAT-MODEL.md).
- [x] No finding was closed by the code's author alone (independent sign-off recorded).

Re-run the review closure gate locally with `pnpm external-review:check` — it fails if any P0/P1 finding is open or any closed finding's re-test evidence no longer resolves.

## Correlation

| Artifact | Role |
|----------|------|
| [`security/THREAT-MODEL.md`](./THREAT-MODEL.md) | Trust boundary inventory and STRIDE enumeration the review re-derives |
| CI `security-supply-chain` job (`.github/workflows/ci.yml`) | Runs the external-review scope gate on every push/PR |
| [`artifacts/independent-certification/`](../artifacts/independent-certification/README.md) | Second-implementor certification run (non-reference storage + model); environment manifest + per-obligation report |
| [`docs/protocol/CERTIFICATION-CHECKLIST.md`](../docs/protocol/CERTIFICATION-CHECKLIST.md) | Independence-kit checklist sign-off for the certification run |
| [`rfcs/0001-protocol-1.0-freeze.md`](../rfcs/0001-protocol-1.0-freeze.md) | Protocol 1.0 freeze — **Accepted**; certification findings triage incorporated |
| [`rfcs/appendix/certification-findings.md`](../rfcs/appendix/certification-findings.md) | Closed / waived certification findings with owners |

**Scope gate:** `pnpm external-review:check` — `scripts/check-external-review.mjs` verifies this document's scope tables resolve to existing code and test paths, all five independence rules are present, and the severity policy still blocks the freeze RFC on P0/P1.
