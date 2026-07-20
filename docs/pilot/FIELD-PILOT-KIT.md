# Field pilot kit — device matrix & offline bundle recipe

| Meta | Value |
|------|-------|
| **Audience** | Field operators assembling a two-week B8 pilot |
| **Verified** | 2026-07-16 |
| **Companion** | Consent + friction telemetry configuration: [§5](#5-consent--friction-telemetry-configuration) · [`packages/telemetry/README.md`](../../packages/telemetry/README.md) |

This kit is the operator path for a **sovereign offline edge** pilot: certified on-device bindings, teacher task-graph pack, friction samples as behavioral metadata only (never raw keystrokes). Simulations and Playground do not surface thermal throttling or classroom STT noise — the device matrix below is what does.

**Runnable reference:** [`examples/offline-edge/`](../../examples/offline-edge/) (mock SLM, llama.cpp desktop, local STT, local VLM — all network-denied).

---

## 1. Device matrix (supported for this pilot)

Pilot hardware is pinned to the same certification profiles as B6 SLM certify. Do not expand the matrix mid-pilot without a new findings record.

| Role | Profile id | Adapter | Hardware class | Representative SKU (operator target) | Cert report (committed) |
|------|------------|---------|----------------|--------------------------------------|-------------------------|
| **Primary — Android mid-range** | `android-mid` (alias `android`) | `onnx` | `mid-range-android` | Mid-range Android phone/tablet, ≥6 GB RAM, Android 12+, no cellular required for turns | [`packages/bindings-slm/android/certification/reports/android.cert.json`](../../packages/bindings-slm/android/certification/reports/android.cert.json) |
| **Secondary — Apple silicon** | `apple-silicon` | `mlx` | `apple-silicon` | One Apple silicon Mac (M1/M2/M3 class), macOS 14+, arm64 only | [`packages/bindings-slm/macos/certification/reports/apple-silicon.cert.json`](../../packages/bindings-slm/macos/certification/reports/apple-silicon.cert.json) |
| **Lab / smoke — desktop CPU** | `desktop` | `llamacpp` | `cpu` | Optional operator laptop for bundle dry-run (not a classroom device) | [`packages/bindings-slm/certification/reports/certification.report.json`](../../packages/bindings-slm/certification/reports/certification.report.json) |

### Matrix rules

- **Minimum set for a valid pilot window:** ≥1 Android mid-range device **and** ≥1 Apple silicon host. Desktop is optional for assembly only.
- Every turn is scoped by `subjectId` + `deviceId`. Two devices never share a subject id. Concurrent turns for the same `subjectId` must serialize through the edge storage driver (no cross-device read-modify-write races on mastery).
- Network is **optional**. Turns must complete with locality policy `sovereign-default` / zero egress (B1). Sync of friction samples (when allowed) uses `markSynced` — never raw utterance bodies.
- Replayed sync / duplicate requests must stay **idempotent** (same `syncAttemptId` → no double-applied mastery). Partial failure after the first durable side effect must surface a typed error; do not silently continue.

### NFR budget (hot path)

| Gate | Bound | Source |
|------|-------|--------|
| First-token p95 (mid-range) | ≤1500 ms | NFR-01 / android profile `budgetP95Ms` |
| Friction scan / root scan | ≤64 concepts | CAST cold-start / domain-loader bounded scans |
| Pilot golden suite size | ≤64 cases | cold-start + guidance evals |

---

## 2. Offline bundle — version manifest (pins)

Copy this table into the pilot runbook sheet. Versions are workspace pins as of **Verified: 2026-07-16**. Bump only with a findings note.

| Component | Pin | Path / command |
|-----------|-----|----------------|
| Monorepo package set | `0.1.0` workspace | `pnpm install --frozen-lockfile` at repo root |
| Teacher task-graph pack | `teacher-cbse-slice@1.0.0` | `packages/domain-loader/fixtures/packs/teacher-cbse-slice.json` |
| Teacher route goldens | `teacher-cbse-slice.route-goldens.v1` | `…/teacher-cbse-slice.route-goldens.json` |
| Cold-start goldens | `teacher-cbse-slice.coldstart-goldens.v1` | `…/teacher-cbse-slice.coldstart-goldens.json` |
| SLM — Android | profile `android-mid`, ORT `1.17.3`, model fixture `phi-mini-int8-within` | `packages/bindings-slm/certification/android.profile.json` |
| SLM — Apple | profile `apple-silicon`, MLX `0.22.0`, model fixture `phi-mlx-mini-apple` | `packages/bindings-slm/certification/apple-silicon.profile.json` |
| SLM — Desktop smoke | profile `desktop`, llama.cpp `b5750`, GGUF `phi-ck03-llama` Q4_K_M | `packages/bindings-slm/certification/desktop.profile.json` |
| Speech (B7) | `sutra-bindings-speech@0.1.0` | `pnpm offline-edge:speech` |
| Vision (B7) | `sutra-bindings-vision@0.1.0` | `pnpm offline-edge:vision` |
| Knowledge packs (B6/B8) | `sutra-bindings-knowledge@0.1.0` + teacher/doctor flagship fixtures | `packages/bindings-knowledge/` |
| Telemetry | `@moolam/telemetry@0.1.0` | write-ahead friction samples; **no raw keystrokes** |
| Guidance eval threshold | `minAggregateScore: 0.85` | `evals/guidance/threshold.json` |
| CAST-05 cold-start | obligation `CAST-05.1`, min root evidence `3` | `packages/edge-agent` / cloud `task_router` |

**Invariant:** the offline bundle **must** include certified bindings (B6 SLM profiles above), speech/vision (B7), and the teacher pack + graph (B8) at these pins. Do not substitute an uncertified adapter mid-pilot.

---

## 3. Offline bundle build recipe (step-by-step)

Worked path from a clean checkout. All commands are from the **repository root** unless noted.

### 3.1 Prerequisites

- Node **22** + pnpm **10.30.3** (see root `packageManager` / `engines`)
- For Apple device: Darwin arm64 host for MLX native path (CI stand-in is acceptable for dry-run only)
- For Android device: USB debugging or emulator matching `mid-range-android` class
- Disk: ≥4 GB free for model fixtures + reports

### 3.2 Install & build

```bash
pnpm install --frozen-lockfile
pnpm build
```

### 3.3 Prove certified bindings (B6) — red→green locally optional

```bash
# Desktop CPU smoke (lab)
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify \
  --profile desktop --adapter llamacpp

# Android mid-range profile (CI stand-in or device)
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify \
  --profile android-mid --adapter onnx

# Apple silicon profile
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify \
  --profile apple-silicon --adapter mlx
```

Committed green reports must remain green; a hash mismatch prints `CERT FAIL` and must not ship.

### 3.4 Assemble the offline edge turn paths (B7 + host)

```bash
cd examples
pnpm offline-edge              # mock SLM — always-offline smoke
pnpm offline-edge:llamacpp     # desktop GGUF path, network denied
pnpm offline-edge:speech       # Indic / code-switched STT fixture
pnpm offline-edge:vision       # CK-06 VLM fixture
```

Each successful run is a **subject-scoped** turn (`subjectId` / `deviceId` in structured events). Confirm logs never contain learner utterance plaintext.

### 3.5 Pin the teacher pack into the agent boot

Production / cloud default and Playground boot use `teacher-cbse-slice@1.0.0` from:

`packages/domain-loader/fixtures/packs/teacher-cbse-slice.json`

Operator checklist:

1. Copy or bind that file into the device offline assets directory (path is host-specific; keep the filename).
2. Record `packId` + `version` in the pilot sheet (must equal `teacher-cbse-slice` / `1.0.0`).
3. Smoke route parity offline:

```bash
# Cloud router goldens (no network)
cd packages/cloud-orchestrator && pytest -q tests/test_teacher_route_parity.py tests/test_coldstart_parity.py

# Edge TS route_core goldens
cd playground && pnpm exec node --test tests/teacher_route_parity.test.mjs tests/coldstart_parity.test.mjs
```

### 3.6 Friction telemetry (pointer)

Full consent record shape, write-ahead / `markSynced` flow, sovereignty boundary, and operator checklist live in **[§5 Consent & friction telemetry configuration](#5-consent--friction-telemetry-configuration)**. Package API: [`packages/telemetry/README.md`](../../packages/telemetry/README.md).

### 3.7 Bundle directory layout (worked example)

After assembly, an operator staging directory looks like:

```text
pilot-bundle-2026-07-16/
  manifest.md                 # copy of §2 table above
  packs/
    teacher-cbse-slice.json   # byte-identical to domain-loader fixture
  bindings/
    slm/                      # profile ids + fixture hashes from §2
    speech/                   # bindings-speech 0.1.0 artifacts used by offline-edge:speech
    vision/                   # bindings-vision 0.1.0 artifacts used by offline-edge:vision
  reports/
    android.cert.json
    apple-silicon.cert.json
    certification.report.json # desktop optional
  examples/
    offline-edge/             # scripts that prove network-denied turns
```

Zip or sync that tree to each device. Do not include learner transcripts, screenshots of answers, or keystroke logs.

### 3.8 Observability on device

Structured events only, for example:

- `coldstart.gate` — `subjectId`, `deviceId`, `outcome` (`block_advance` | `allow_advance`)
- `bindings_slm.certify` / offline-edge turn completion — outcome classes, never utterance text
- Friction collector persistence outcomes — success / typed failure; no silent catch-and-continue

---

## 4. Failure modes operators must rehearse

| Failure | Expected behavior |
|---------|-------------------|
| Concurrent turns same `subjectId` | Serialize; no cross-device mastery corruption |
| Kill mid-write after first durable effect | Typed error on resume; no double-apply on replay |
| Duplicate sync payload | Idempotent — same attempt id does not double-count friction |
| Downstream timeout (STT / VLM / SLM) | Typed error to caller; turn aborted cleanly |
| Uncertified model swap | Reject — certify must fail before pilot day 1 |

---

## 5. Consent & friction telemetry configuration

This section is the operator contract for **consent-gated** friction telemetry during the field pilot. It matches `@moolam/telemetry` `CognitiveTelemetryCollector` behavior (write-ahead persist, `unsynced` / `markSynced`) — not aspirations.

### 5.1 Consent record shape (worked example)

Store one consent record **per subject × device** before any friction sample may leave the device. Keep it on-device (or self-hosted vault); do not embed utterance text.

```json
{
  "schemaVersion": "field-pilot.consent.v1",
  "consentId": "consent.subj.pilot.android.001",
  "subjectId": "subj.pilot.learner.a1",
  "deviceId": "dev-android-mid-01",
  "grantedAt": "2026-07-16T09:00:00.000Z",
  "expiresAt": "2026-07-30T18:00:00.000Z",
  "locality": "on-device",
  "scopes": {
    "frictionSamplePersist": true,
    "frictionSampleSync": true,
    "trajectoryExport": false,
    "rawKeystrokeExport": false,
    "utteranceExport": false
  },
  "operatorId": "op.field.delhi.01",
  "notes": "Two-week B8 pilot; sync friction metadata only when network allowed"
}
```

| Field | Rule |
|-------|------|
| `subjectId` / `deviceId` | Required; never reuse a subject id across devices |
| `scopes.frictionSamplePersist` | Must be `true` to run the collector |
| `scopes.frictionSampleSync` | Must be `true` before calling cloud sync / `markSynced` path |
| `scopes.trajectoryExport` | Must stay `false` for this pilot (B9 owns trajectory consent later) |
| `scopes.rawKeystrokeExport` / `utteranceExport` | Always `false` — behavioral metadata only |

**Validation failure** (missing consent, expired `expiresAt`, or forbidden scope `true`): typed contract error naming the obligation (e.g. `field_pilot.consent.denied`); do not collect or sync. Never silent catch-and-continue.

### 5.2 Collector write-ahead + `markSynced` (real API)

Lifecycle per exercise (from `packages/telemetry/src/collector.ts`):

```text
prompt-rendered → [input | deletion | assistance-requested]* → submitted
                                                              ↓
                                              write-ahead INSERT (synced=0)
                                                              ↓
                                         (optional) sync FrictionSample[]
                                                              ↓
                                              markSynced([capturedAt…])
```

Worked TypeScript (same shape as the package README / offline-edge host):

```ts
import { CognitiveTelemetryCollector } from "@moolam/telemetry";

// Consent gate (operator): scopes.frictionSamplePersist === true for this subjectId+deviceId
const telemetry = new CognitiveTelemetryCollector(storageDriver, hlcClock);
await telemetry.initialize();

telemetry.observe({ type: "prompt-rendered", conceptId: "math.fractions", atMs: Date.now() });
telemetry.observe({ type: "input", atMs: Date.now(), charsDelta: 12 }); // charsDelta only — never the string
telemetry.observe({ type: "submitted", atMs: Date.now(), outcome: "correct" });
// `submitted` finalizes FrictionSample and persists write-ahead before ack

const pending = await telemetry.unsynced(); // metadata rows only
// … after successful SyncResponse compaction, and only if scopes.frictionSampleSync:
await telemetry.markSynced(pending.map((s) => s.capturedAt));
```

| Step | Stays sovereign (on-device) | May leave device (if sync consented) |
|------|---------------------------|--------------------------------------|
| Keystrokes / utterance text | Always | **Never** |
| `charsDelta`, hesitation, velocity, revisions, assistance, outcome | Durable in SQLite | Allowed as `FrictionSample` |
| Half-open exercise (no `submitted`) | Discarded — must not poison mastery | N/A |
| After `markSynced` | Row remains locally with `synced=1` | Cloud has already compacted that `capturedAt` |

`INSERT OR IGNORE` on `captured_at` makes persist **idempotent**. Replaying `markSynced` with the same HLC timestamps is safe (no double-count). Concurrent turns for the same `subjectId` must serialize on the storage driver — no cross-subject queries.

**Partial failure:** if write-ahead succeeds but the turn fails afterward, the sample stays durable (`synced=0`) until a later successful sync; do not delete acknowledged samples. If write-ahead throws, surface the typed storage error — do not acknowledge the turn as observed.

**Bounded scans:** use `unsynced()`, `durableSampleCount()`, or `castIntegrityProbe()` — never `SELECT *` an unbounded friction log in operator tooling.

### 5.3 What leaves the device vs what stays sovereign

| Artifact | Locality | Pilot rule |
|----------|----------|------------|
| Consent record | on-device / self-hosted vault | Never in SyncRequest body |
| Raw keystrokes / learner utterance | on-device only | Forbidden in export and logs |
| `FrictionSample` | on-device store; optional sync | Only with `frictionSampleSync` |
| Teacher pack / model weights | on-device bundle | From §2 pins; no network fetch mid-turn |
| Cert reports | operator laptop + device | Metadata only |
| Trajectory / training export | off by default | `trajectoryExport: false` until B9 |

Observability events (`telemetry.persist`, sync outcomes, `coldstart.gate`) carry `subjectId`, `deviceId`, and outcome class — **never** plaintext content.

### 5.4 Operator checklist (day-0)

1. [ ] Consent record present for every `subjectId`×`deviceId` on the matrix; `expiresAt` covers the two-week window.
2. [ ] `rawKeystrokeExport`, `utteranceExport`, `trajectoryExport` are `false`.
3. [ ] Host uses only `CognitiveTelemetryCollector` (no ad-hoc keystroke logs).
4. [ ] Smoke: run `pnpm offline-edge` (or device equivalent); confirm friction row written; confirm logs have no utterance text.
5. [ ] If sync enabled: confirm `unsynced()` → sync → `markSynced`; replay same timestamps stays idempotent.
6. [ ] Concurrent two-device test: distinct `subjectId`s; same-subject dual device **rejected** or strictly serialized.
7. [ ] Kill app mid-turn before `submitted`: no durable sample (partial discarded).
8. [ ] Kill after write-ahead: sample survives restart with `synced=0`.

---

## 6. What this kit does **not** cover (next slices)

- Two-week execution + dated findings → [`docs/pilot/findings/`](./findings/) · summary [`PILOT-SUMMARY.md`](./PILOT-SUMMARY.md) · exit [`PILOT-EXIT-REVIEW.md`](./PILOT-EXIT-REVIEW.md) · freeze draft [`P7-FREEZE-RFC-DRAFT.md`](./P7-FREEZE-RFC-DRAFT.md) (`pnpm field-pilot:execute` / `findings:check` / `exit-review`)
- Trajectory export consent gates → Track B B9
- Formal accepted freeze RFC under `rfcs/` → Track A P7 FREERFC-001 (consumes the draft above)

---

## 7. Doc consistency gate

```bash
node scripts/check-field-pilot-kit.mjs
# or: pnpm field-pilot-kit:check
```

The gate asserts this file exists, the device matrix + version pins reference real repo paths, consent / `markSynced` / privacy sections are present, and the offline-edge / telemetry READMEs link here.
