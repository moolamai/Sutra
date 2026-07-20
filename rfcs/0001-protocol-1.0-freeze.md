# RFC 0001: Protocol 1.0 freeze

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Author(s)** | Moolam maintainers |
| **Date** | 2026-07-17 |
| **Target version** | `1.0.0` |
| **Maintainer acceptance** | Track A Lead <track-a@moolam.ai> 2026-07-17; Protocol Owner <protocol@moolam.ai> 2026-07-17 |
| **Production publish gate** | **Unlocked** — [`appendix/production-publish-gate.json`](./appendix/production-publish-gate.json) (`unlocked: true`); see Maintainer acceptance workflow |
| **Evidence appendix status** | Coverage report compiled — [`appendix/conformance-coverage.md`](./appendix/conformance-coverage.md) · [`appendix/conformance-coverage.json`](./appendix/conformance-coverage.json) · certification triage [`appendix/certification-findings.md`](./appendix/certification-findings.md) |
| **Related** | [`security/THREAT-MODEL.md`](../security/THREAT-MODEL.md) · [`security/EXTERNAL-REVIEW.md`](../security/EXTERNAL-REVIEW.md) · [`docs/pilot/PILOT-SUMMARY.md`](../docs/pilot/PILOT-SUMMARY.md) · [`docs/protocol/CERTIFICATION-CHECKLIST.md`](../docs/protocol/CERTIFICATION-CHECKLIST.md) · [`artifacts/independent-certification/reports/certification-report.json`](../artifacts/independent-certification/reports/certification-report.json) |

## Summary

This RFC freezes Sutra's public protocol and cognitive contract surfaces at `1.0.0`. After acceptance, published wire shapes and obligation IDs evolve additively within major version 1: existing fields, variants, semantics, and obligation IDs are not removed, renamed, or narrowed. Field-pilot finding `FP-002` is **Closed** with the `hi-classroom-noise` fixture; independent certification (DIST-01) is green on the checklist suite; maintainer acceptance is recorded above.

## Motivation

Third-party implementors need a stable specification they can implement without reading the reference source. A freeze is justified only when every public wire interface has executable evidence, field-pilot gaps have explicit dispositions, security and supply-chain gates are green, and maintainers record acceptance. Freezing while an issue is silently deferred would turn known debt into protocol law.

The same stability matters across domains: a teacher deployment must replay offline mastery safely, while a clinical or legal deployment must reject cross-subject access and preserve auditability. Neither can tolerate a patch release silently changing wire meaning.

## Scope

The freeze covers:

1. `@moolam/sync-protocol` wire schemas and semantics:
   - `SyncRequest` / `SyncResponse` and `CognitiveState`
   - harness frame discriminated union
   - tool-call envelope and closed error vocabulary
   - metering event contract
   - degradation registry document and bindings
2. `@moolam/contracts` public cognitive interfaces:
   - memory, model, reasoning, speech, vision, tool, planning, knowledge, and runtime
3. Published conformance obligation IDs and their verbatim `MUST` clauses.

Reference implementations, private storage layouts, routing heuristics, model providers, and domain packs are not frozen unless they are represented by one of those public contracts.

## Additive-only policy after acceptance

Within major version 1:

- Existing required fields, union variants, enum members, error codes, and obligation IDs **MUST NOT** be removed, renamed, or assigned incompatible semantics.
- New fields are optional and must have behavior defined for older peers that ignore them.
- New union variants or enum members require an explicit compatibility path for older implementations.
- Obligation IDs are append-only. A rename is a deprecation plus a new ID, never an in-place rewrite.
- Wire changes require schema-drift CI, changelog entry, golden fixture updates, and conformance evidence in the same change.
- A breaking change requires a new major version and an accepted RFC.

Worked example: adding optional `traceContext` metadata to `SyncRequest` is additive if a 1.0 peer may ignore it. Renaming `subjectId`, changing replay from idempotent to additive, or removing `HARNESS_ERROR` is breaking and forbidden in 1.x.

## Behavior under offline operation and sync divergence

The freeze preserves state-based CRDT join semantics: commutative, associative, and idempotent merge; G-Counter shards merge by `max`; HLC order resolves LWW ties deterministically. Replayed `SyncRequest` payloads cannot double-apply friction evidence. A malformed or version-incompatible payload is quarantined, not retried indefinitely. A device that remains offline keeps local state authoritative until a validated response converges it.

Every read/write remains scoped by `subjectId`; `deviceId` is correlation metadata, not an authorization substitute. Raw learner content stays within the declared `on-device` / `self-hosted` locality. Model output and wire payloads remain untrusted and are parsed at the boundary.

## Evidence appendix

### Coverage method

The percentages below are **obligation coverage**, not source-line coverage:

`passed published obligations ÷ declared published obligations × 100`.

An obligation is covered only when the known-good reference harness yields `outcome: pass` in the compiled report. Denominator and verdicts are generated from the conformance catalog (`pnpm conformance:coverage`).

### Second-implementation certification (DIST-01)

An independent implementor was commissioned with **non-reference** storage and
model stacks and supported with the independence kit only (no monorepo
checkout). Checklist-suite results and environment attestation:

| Artifact | Path |
|----------|------|
| Onboarding | [`artifacts/independent-certification/ONBOARDING.md`](../artifacts/independent-certification/ONBOARDING.md) |
| Environment manifest | [`artifacts/independent-certification/reports/environment-manifest.json`](../artifacts/independent-certification/reports/environment-manifest.json) |
| Per-obligation report | [`artifacts/independent-certification/reports/certification-report.json`](../artifacts/independent-certification/reports/certification-report.json) |
| Checklist sign-off | [`docs/protocol/CERTIFICATION-CHECKLIST.md`](../docs/protocol/CERTIFICATION-CHECKLIST.md) §6 |

**Run outcome (2026-07-17):** `pass` — 10/10 checklist obligations
(`SYNC-01.1`, `SYNC-01.2`, `CK-02.1`–`CK-02.3`, `CK-03.1`–`CK-03.3`,
`CK-03.L1`, `CK-03.L2`). Storage: file-backed JSONL. Model: deterministic
on-device probe. Neither stack is shipped as a reference monorepo binding.

Triage of certification findings (closed / waived with owner+expiry):
[`appendix/certification-findings.md`](./appendix/certification-findings.md) ·
[`appendix/certification-findings.json`](./appendix/certification-findings.json).
`CERTRUN-F-003` waives independent coverage of the full 34-id catalog through
2026-10-01 (reference catalog remains 34/34 green; DIST-01 bar is the checklist
suite + non-reference stacks).

### Conformance coverage report

Compiled appendix (obligation ID → pass/fail, with B-track suite links):

- Markdown: [`appendix/conformance-coverage.md`](./appendix/conformance-coverage.md)
- Machine-readable: [`appendix/conformance-coverage.json`](./appendix/conformance-coverage.json)

| Aggregate | Value |
|-----------|------:|
| Interfaces | 13 |
| Declared obligations | 34 |
| Passed | 34 |
| Failed | 0 |
| Coverage | **100%** |

SpeechInterface contract coverage is green in the appendix; field-pilot finding `FP-002` is **Closed** (`hi-classroom-noise` fixture + `fp002_classroom_noise.test.mjs`).

### Public wire interfaces

Every public wire interface is listed here with a numeric percentage and executable evidence.

| Public wire interface | Declared obligations | Covered | Coverage | Evidence |
|-----------------------|---------------------:|--------:|---------:|----------|
| Sync request/response + cognitive state (`SYNC-01`…`SYNC-08`) | 8 | 8 | **100%** | `packages/sync-protocol/tests/wire_schemas.test.mjs`, `packages/sync-protocol/tests/golden_joins.test.mjs`, `packages/sync-protocol/tests/merge_laws.test.mjs`, `packages/sync-protocol/tests/sync_wire_headers.test.mjs` |
| Harness frame union (8 variants + ordering/subject semantics) | 10 | 10 | **100%** | `packages/sync-protocol/tests/harness_frames.test.mjs`, `packages/sync-protocol/tests/harness_stream_semantics.test.mjs` |
| Tool-call envelope (shape, normalization, error vocabulary, repair/stream parsing) | 5 | 5 | **100%** | `packages/sync-protocol/tests/tool_envelope.test.mjs`, `packages/sync-protocol/tests/tool_envelope_errors.test.mjs`, `packages/sync-protocol/tests/tool_envelope_fixtures.test.mjs` |
| Metering event contract (shape, parity, bounded budgets, metadata-only) | 4 | 4 | **100%** | `packages/sync-protocol/tests/metering.test.mjs`, `packages/sync-protocol/tests/meter_events_parity.test.mjs`, `packages/sync-protocol/tests/metering_budget.test.mjs` |
| Degradation registry (schema, bindings, exports, forced-failure vectors) | 4 | 4 | **100%** | `packages/sync-protocol/tests/degradation_registry.test.mjs`, `packages/sync-protocol/tests/degradation_registry_export.test.mjs`, `packages/sync-protocol/tests/degradation_stub_vectors.test.mjs` |

### Cognitive interface conformance

Compiled from the coverage appendix (known-good harness run). Suite paths are B-track evidence.

| Public interface | Spec obligations | Coverage | B-track suite |
|------------------|------------------|---------:|---------------|
| Wire `SyncRequest` | `SYNC-01.1`, `SYNC-01.2` | **100%** | `packages/contract-conformance/tests/wire_shape.test.mjs` |
| `MemoryInterface` | `CK-02.1`…`CK-02.3` | **100%** | `packages/contract-conformance/tests/memory_obligations.test.mjs` |
| `ModelInterface` + locality | `CK-03.1`…`CK-03.3`, `CK-03.L1`, `CK-03.L2` | **100%** | `packages/contract-conformance/tests/model_obligations.test.mjs`, `packages/contract-conformance/tests/locality_policy.test.mjs` |
| `ReasoningInterface` | `CK-04.1`, `CK-04.2` | **100%** | `packages/contract-conformance/tests/reasoning_obligations.test.mjs` |
| `SpeechInterface` | `CK-05.1`, `CK-05.2` | **100%** (`FP-002` Closed) | `packages/contract-conformance/tests/speech_obligations.test.mjs`, `packages/bindings-speech/tests/fp002_classroom_noise.test.mjs` |
| `VisionInterface` | `CK-06.1`, `CK-06.2` | **100%** | `packages/contract-conformance/tests/vision_obligations.test.mjs` |
| `ToolInterface` | `CK-07.1`…`CK-07.3` | **100%** | `packages/contract-conformance/tests/tool_obligations.test.mjs` |
| `PlanningInterface` | `CK-08.1`, `CK-08.2` | **100%** | `packages/contract-conformance/tests/planning_obligations.test.mjs` |
| `KnowledgeConnectorInterface` | `CK-09.1`…`CK-09.3` | **100%** | `packages/contract-conformance/tests/knowledge_obligations.test.mjs` |
| CAST cold-start | `CAST-05.1` | **100%** | `packages/contract-conformance/tests/cast_obligations.test.mjs` |
| Runtime + refusal composition | `RT-*`, `CK-10.1`…`CK-10.3` | **100%** | `packages/contract-conformance/tests/runtime_obligations.test.mjs`, `packages/contract-conformance/tests/refusal_decline.test.mjs` |

Commands:

```bash
pnpm conformance:coverage
pnpm conformance:coverage:check
pnpm conformance
pnpm conformance:prove
pnpm golden:joins:prove
pnpm field-pilot:exit-review
pnpm threat-model:stride:check
pnpm audit:gate
pnpm sbom:check
pnpm signing:verify
```

### Field-pilot evidence

Source: [`docs/pilot/PILOT-SUMMARY.md`](../docs/pilot/PILOT-SUMMARY.md) and [`docs/pilot/PILOT-EXIT-REVIEW.md`](../docs/pilot/PILOT-EXIT-REVIEW.md).

| Finding | Severity | Disposition for freeze |
|---------|----------|------------------------|
| `FP-001` offline Android sync gap | P2 | **Closed** — write-ahead samples survive offline/restart and replay is idempotent |
| `FP-002` Indic STT classroom noise | P1 | **Closed** — `hi-classroom-noise` fixture + confidence regression test |
| `FP-003` routing parity | P3 | **Closed** — guidance-eval parity held |
| `FP-004` privacy / `markSynced` / routing sign-off | P3 | **Closed** |

### Security and supply-chain evidence

- STRIDE threat model: every mitigated threat has a resolving regression link.
- External review: 9 findings filed; 7 closed, 2 accepted residuals, 0 open P0/P1.
- Dependency audit: critical/high findings block unless owner + expiry suppression exists.
- Release: CycloneDX SBOMs generated and signing/provenance policy verified before production upload.

## Open issue disposition

No issue may be omitted. Each row is `closed`, `waived` with owner and expiry, or a blocking status that prevents acceptance.

| Issue | Severity | Status | Owner | Expiry / review date | Evidence / required action |
|-------|----------|--------|-------|----------------------|----------------------------|
| `FP-002` Indic STT classroom-noise fixture | P1 | **Closed** | Speech binding owner | 2026-07-17 | `hi-classroom-noise` + `packages/bindings-speech/tests/fp002_classroom_noise.test.mjs` |
| `CERTRUN-F-003` independent catalog breadth | P2 | Waived | Track A lead | 2026-10-01 | Checklist suite is DIST-01 bar; reference catalog 34/34 green — [`appendix/certification-findings.md`](./appendix/certification-findings.md) |
| `F-EXT-008` host tool sandbox isolation | P3 | Accepted residual | Domain integrator | 2026-10-01 | `RR-HOST-TOOL-001` in threat model |
| `F-EXT-009` deployment TLS policy | P3 | Accepted residual | Deployment operator | 2026-10-01 | `RR-TLS-001` in threat model |
| `GHSA-fx2h-pf6j-xcff` vite dev-server path bypass | High dependency advisory | Waived for release tooling only | Track A lead | 2026-10-01 | Dev/build-only suppression in `security/AUDIT-SUPPRESSIONS.json`; production artifacts do not bundle vite |

## Acceptance criteria

This RFC is **Accepted**. The criteria that unlocked acceptance:

1. `FP-002` is closed with executable re-test evidence (`fp002_classroom_noise.test.mjs`).
2. The compiled coverage appendix remains green (`pnpm conformance:coverage:check`) and matches the published obligation catalog.
3. No security-review P0/P1 remains open.
4. Dependency audit, SBOM, signing, conformance, schema drift, golden joins, and field-pilot exit gates are green.
5. The header's **Maintainer acceptance** row names every accepting maintainer and date.

P5 production registry publish is unlocked (`rfcs/appendix/production-publish-gate.json` → `unlocked: true`). After this work lands on `main`, cut `v1.0.0` through `.github/workflows/release.yml` (push annotated tag) to execute npm + PyPI production publish with repository vars set.

## Maintainer acceptance workflow

Concrete operator path (do not skip blockers):

1. Close or time-bound-waive every blocking disposition row (none remain after `FP-002` closure).
2. Confirm coverage appendix is green: `pnpm conformance:coverage:check`.
3. Set the header **Status** to `Accepted`.
4. Replace **Maintainer acceptance** with named maintainers and ISO dates, for example:
   `Alice Maintainer <alice@example.com> 2026-07-20; Bob Maintainer <bob@example.com> 2026-07-20`.
5. Refresh the production gate artifact and verify unlock:
   ```bash
   pnpm production-publish:gate -- --write
   pnpm production-publish:gate
   ```
   Expected: `rfcs/appendix/production-publish-gate.json` has `"unlocked": true` and
   `"npmAllowProdPublish": "true"`.
6. Flip GitHub repository variables only after step 5 is green:
   - `NPM_ALLOW_PROD_PUBLISH=true`
   - `PYPI_ALLOW_PROD_PUBLISH=true`
7. Tag `v1.0.0` through `.github/workflows/release.yml`. The workflow reads
   `FREEZE_RFC_UNLOCKED` from the gate JSON; production registry targets stay
   forced to scratch while `unlocked` is false — even if the vars were flipped early.

Replay of steps 5–6 is idempotent: re-running the gate with an Accepted RFC
rewrites the same unlock decision. Concurrent acceptance edits must land as one
PR so Status, sign-off, issue disposition, and gate JSON move together.

## Drawbacks

Additive-only evolution makes some cleanups impossible in 1.x and can increase schema complexity. Compatibility fixtures and deprecation windows add maintenance cost. That cost is deliberate: ecosystem implementors should not absorb unannounced breakage.

## Alternatives

- **Freeze without second implementor:** rejected; DIST-01 requires independent stacks.
- **Treat TypeScript types as sufficient:** rejected; independent implementations need executable wire and conformance evidence.
- **Allow silent deferrals:** rejected; every issue must be closed, time-bounded, or blocking.
- **Do nothing:** keeps 0.x flexibility but prevents trustworthy 1.0 publication.

## Migration

No migration is authorized by this draft. Existing 0.1 implementations continue using current schemas. On acceptance, implementations certify against the final 1.0 catalog and schema bundle. Later additive fields must be safely ignorable by 1.0 peers; breaking evolution waits for 2.0.

Implementors upgrading after the freeze should follow the
[`Post-1.0 protocol evolution guide`](../docs/protocol/DEPRECATION-POLICY.md)
for literal version checks, deprecated-field advisories, migration sequencing,
subject-isolation proofs, bounded retries, and metadata-only observability.

## Unresolved questions

1. ~~Who records final maintainer acceptance, and on what date?~~ **Resolved** — see header Maintainer acceptance (2026-07-17).
2. ~~What is the final generated conformance denominator per interface?~~ **Resolved:** 34 declared / 34 passed (see coverage appendix).
3. ~~What exact fixture and threshold close `FP-002`?~~ **Resolved:** `hi-classroom-noise` with final confidence ≤ 0.35 under ambient marker; quiet fixtures remain above that ceiling.

Production publish is unlocked. Cut `v1.0.0` via the release workflow after lockstep version bump.

## Observability

Freeze checks emit structured events with a CI `subjectId`, `deviceId`, outcome, and named obligation/failure class. Evidence documents and logs contain metadata and aggregate verdicts only—never raw learner utterances or prompt content.
