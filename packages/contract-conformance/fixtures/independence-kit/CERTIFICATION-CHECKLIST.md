# Protocol certification checklist — independence kit

Use this checklist when certifying an **independent** implementation against the
published conformance CLI and wire fixtures. You need only:

1. `@moolam/contract-conformance` (npm pack or registry)
2. The shipped **independence kit fixtures** tarball (`fixtures/independence-kit.tgz`)
3. This checklist

No Sutra monorepo checkout is required.

**Verified layout:** Node.js ≥ 22 · package `@moolam/contract-conformance` ≥ 0.1.0

> Binding-adapter badge criteria (model / speech / vision profiles): see
> [`docs/bindings/CERTIFIED-BINDING.md`](../bindings/CERTIFIED-BINDING.md) and
> [`docs/sdk/binding-certification-guide.md`](../sdk/binding-certification-guide.md).
> This document covers the **protocol / independence-kit** obligation surface.

## 0. Kit install (no monorepo)

```bash
# From a published or packed package (example with local pack):
npm pack @moolam/contract-conformance   # or: pnpm pack in CI artifact dir
mkdir -p /tmp/indekit && tar -xzf moolam-contract-conformance-*.tgz -C /tmp/indekit
cd /tmp/indekit/package

# Extract wire fixtures shipped inside the package
mkdir -p ./kit && tar -xzf fixtures/independence-kit.tgz -C ./kit
ls ./kit/CERTIFICATION-CHECKLIST.md ./kit/MANIFEST.json ./kit/sync ./kit/wire
```

Or use the thin verifier (same package tree / tools):

```bash
node tools/conformance-cli/bin/conformance-cli.mjs verify --kit ./kit
```

Every checklist run must declare `subjectId` and `deviceId`. Reports and logs
must **never** embed utterance, prompt, or learner content bodies — only
obligation ids, outcomes, and typed codes.

## 1. Sync obligations

| ID | Surface | Pass when | Kit fixtures |
|----|---------|-----------|--------------|
| `SYNC-01.1` | SyncRequest validates against frozen schema | Obligation verdict `pass` | `wire/bundle.json`, `sync/wire-parity/golden-envelopes.json` |
| `SYNC-01.2` | `edgeState.subjectId` equals obligation-scoped `subjectId` | Cross-subject rewrite fails the check | same + `sync/golden-joins/20-subject-isolation-refused.json` |

```bash
npx @moolam/contract-conformance \
  --factory ./conformance-factory.mjs \
  --subject-id cert.sync.a \
  --device-id external-ci \
  --only SYNC-01.1,SYNC-01.2 \
  --json
```

Also walk golden-join cases under `sync/golden-joins/` (merge laws) and
advisories under `sync/advisories/` — replayed / duplicate envelopes must be
idempotent (no double-apply).

- [ ] `SYNC-01.1` green for factory-produced SyncRequest
- [ ] `SYNC-01.2` green; seeded cross-subject payload fails only that id
- [ ] Golden joins + advisories available from kit (no monorepo paths)

## 2. Harness stream obligations

Harness frames are typed (`SESSION_START` … `HARNESS_ERROR`) with monotonic
`sequenceIndex` and subject scoping. Source semantics:
[`HARNESS-STREAM-SEMANTICS.md`](./HARNESS-STREAM-SEMANTICS.md).

| Check | Pass when | Kit fixtures |
|-------|-----------|--------------|
| Frame shape | Frames match `sync/wire-parity/harness-frames.json` types | `harness-frames.json` |
| Golden turns | Thought/answer, tool fence, meter, terminal error replay byte-stable | `sync/golden-turns/*` |
| Subject scope | Foreign `subjectId` refused at stream open | frames + turns carry bound `subjectId` |
| Hang / deadline | Stream stall fails the **obligation** with typed timeout — runner continues | CLI `--deadline-ms` |

Meter / tool envelope samples: `sync/wire-parity/meter-events.json`,
`sync/tool-envelope/`. Degradation modes: `sync/degradation-registry/`.

- [ ] Golden turns + harness frames present in extracted kit
- [ ] Factory / harness refuses foreign subject at open
- [ ] Intentional hang under deadline → `timeout` verdict, process exits 1 (not hung)

## 3. Binding obligations (model B0)

| ID | MUST (summary) | Pass when |
|----|----------------|-----------|
| `CK-03.1` | `embed` dimension stable per provider instance | verdict `pass` |
| `CK-03.2` | Streaming yields deltas, not cumulative text | verdict `pass` |
| `CK-03.3` | Providers surface `locality` truthfully | verdict `pass` |

Full binding certify path (profiles, egress record, badge): use
[`binding-certification-guide.md`](../sdk/binding-certification-guide.md).
Independence-kit minimum is a green B0 set via the conformance CLI factory.

```bash
npx @moolam/contract-conformance \
  --factory ./conformance-factory.mjs \
  --subject-id cert.binding.a \
  --device-id external-ci \
  --only CK-03.1,CK-03.2,CK-03.3 \
  --json
```

- [ ] `CK-03.1` / `CK-03.2` / `CK-03.3` all `pass`
- [ ] Report carries `subjectId` / `deviceId`; no content bodies
- [ ] Seeded locality-lie fails only `CK-03.3`

## 4. Locality obligations

| ID | MUST (summary) | Pass when |
|----|----------------|-----------|
| `CK-03.L1` | Regulated / cognitive-state payloads stay on-device or self-hosted | no forbidden third-party egress |
| `CK-03.L2` | Egress initiator `subjectId` equals turn `subjectId` | subject-bound egress only |

- [ ] `CK-03.L1` green under network-denied / locality harness
- [ ] `CK-03.L2` green; cross-subject initiator fails only that id
- [ ] Concurrent certifies for different `subjectId`s do not share mutable state

## 5. Observability & failure attribution

Structured events from the CLI / runner include `subjectId`, `deviceId`,
`obligationId`, and outcome — never raw content. Distinct classes:

| Class | Signal |
|-------|--------|
| MUST fail | `fail` + obligation id + MUST text |
| Hang | `timeout` attributed to obligation |
| Setup / teardown | implementation error (redacted message) |
| Validation | typed contract error naming the obligation |

- [ ] Events / JSON report omit utterance and prompt bodies
- [ ] Hang and setup errors attributed to implementation, not the runner

## 6. Sign-off

| Field | Value |
|-------|-------|
| Implementor / storage stack | `indep-cert-2026-07` · file-backed JSONL (`artifacts/independent-certification/src/storage.mjs`) — **not** reference monorepo storage |
| Model stack | Deterministic on-device probe (`artifacts/independent-certification/src/model.mjs`) — **not** `sutra-bindings-*` |
| Kit package version | `@moolam/contract-conformance` **1.0.0** |
| Fixtures MANIFEST `kitVersion` | `1.0.0` |
| Environment (OS / Node) | See `artifacts/independent-certification/reports/environment-manifest.json` |
| Date | 2026-07-17 |
| Result (all sections green?) | **Pass** — checklist suite 10/10; findings triage in [`rfcs/appendix/certification-findings.md`](../../rfcs/appendix/certification-findings.md); freeze RFC **Accepted**; production gate unlocked |

Onboarding record: [`artifacts/independent-certification/ONBOARDING.md`](../../artifacts/independent-certification/ONBOARDING.md).

Partial pass with waivers requires an explicit freeze-RFC entry — see the
certification-run epic. Full published catalog beyond this checklist suite is
tracked for freeze acceptance (next certification-run slice).
