# Deprecation policy — Hybrid Cognitive Sync Protocol

This document is the published evolution rules for the wire contract in
`@moolam/sync-protocol` (Zod + committed `schemas/`) and its Python twin
(`sutra_orchestrator.contract_models`). It satisfies SYNC-01 (additive-only
wire changes) and Track A exit-gate A-G6.

Companion artifacts:

| Artifact | Role |
|---|---|
| [`../CHANGELOG.md`](../CHANGELOG.md) | Keep a Changelog history; every schema-visible PR updates `[Unreleased]` |
| [`../schemas/`](../schemas/) | Committed JSON Schema; diffs verify changelog entries |
| Root `CONTRIBUTING.md` §9 | RFC process for contract edits |

This policy does **not** move learner content across locality boundaries. Wire
evolution is about field shape and version markers (`subjectId`-scoped
documents stay subject-scoped).

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Package version** | SemVer of `@moolam/sync-protocol` (npm). Baseline **0.1.0**. |
| **`PROTOCOL_VERSION`** | String literal on every envelope / `CognitiveState` (`src/contract.ts`). Baseline today: **`"0.1.0"`**. This is the **wire marker**, not a freeze declaration. |
| **Stage 1 / Track A pre-freeze** | Current program stage: publish rules of change; do **not** freeze protocol 1.0 artifacts. |
| **Stage 3** | Track A P7 (production hardening): threat model, freeze RFC, second implementation, published 1.0 artifacts. **Breaking wire changes are deferred until then.** |
| **Additive** | New optional field, new enum member, or new advisory code that old peers can ignore without changing existing field meanings. |
| **Deprecated** | Still validated and mergeable; documented for removal **no earlier than** Stage 3 major, after the window in §4. |
| **Breaking** | Remove a field, rename a key, change a type, repurpose a value, or tighten validation so previously valid documents fail. |

---

## 2. Additive-only rule (pre–Stage 3)

Until the Stage 3 freeze RFC is **accepted** and 1.0 artifacts are published:

1. **Allowed without Stage 3:** additive schema edits (optional fields with
   defaults or absence-tolerant validators; new enum members; new
   `SyncAdvisory` codes whose absence is safe).
2. **Forbidden until Stage 3:** removals, renames, type changes, semantic
   repurposing of existing keys/values, or making a previously optional field
   required.
3. **Both language twins** (Zod + Pydantic) and `schemas/` export land in the
   **same** PR, with a `[Unreleased]` changelog bullet.
4. Old clients **must** keep working: receivers ignore unknown keys; senders
   omit new optional fields when they do not understand them. Merge remains
   subject-scoped (`subjectId` mismatch stays a hard error).

The baseline package `0.1.0` / wire `"0.1.0"` pair documents the **initial**
surface — it is not permission to break that surface before Stage 3.

---

## 3. `PROTOCOL_VERSION` bump semantics

`PROTOCOL_VERSION` is pinned as a Zod/Pydantic **literal** on every envelope.
Old clients that pin an older literal reject newer documents at the boundary
(typed version mismatch — see SYNC-01 / SYNC-05 quarantine behavior).

| Change class | Wire `PROTOCOL_VERSION` | Package SemVer (typical) | Notes |
|---|---|---|---|
| Docs / fixtures / non-schema | unchanged | patch or docs | No literal bump |
| Additive field / enum / advisory | **MINOR** bump (`1.0.0` → `1.1.0`) | package minor or patch per release process | Old peers that pin the previous literal will fail closed on inbound new docs — that is intentional; upgrade path is “bump client schema,” not silent accept |
| Deprecate-in-place (mark only) | **MINOR** if schema metadata/description or emitted hint changes the committed schema; else unchanged | patch/minor | Deprecated keys **remain** in the schema |
| Breaking (remove / rename / repurpose) | **MAJOR** (`2.0.0`) | package major | **Only after Stage 3 freeze process** |

**What a bump means for old clients**

- A client that still validates `protocolVersion: "1.0.0"` must **not** adopt a
  document carrying `"1.1.0"` without upgrading schemas.
- Cloud / edge that speak a newer minor **may** still **emit** documents that
  omit additive fields so older peers (same major, older minor) can round-trip
  during a migration window — but they must not strip required baseline fields.
- Version mismatch is a **distinct failure class** (4xx / quarantine), never a
  silent merge of incompatible shapes.

Replayed sync (`syncAttemptId`) stays idempotent across additive bumps: the
same attempt id applies once; version checks happen before apply.

### CI enforcement — wire change without bump/changelog fails

Committed fingerprint: `schemas/wire-shape-baseline.json` (per-type drift-canon
hashes + `protocolVersion`). CI runs:

```bash
pnpm protocol:version-bump          # gate
pnpm protocol:version-bump:prove    # seeded unlogged field → red → revert → green
```

| Situation | Gate outcome |
|---|---|
| Schemas match baseline + same `PROTOCOL_VERSION` | pass |
| Schema hash changes, `PROTOCOL_VERSION` unchanged | **fail** `protocol.version_bump.version_required` + unified diff |
| Schema hash changes, version bumped, type missing from `[Unreleased]` | **fail** `protocol.version_bump.changelog_required` + diff |
| Version + changelog OK, baseline file not refreshed | **fail** `protocol.version_bump.baseline_stale` — run `pnpm protocol:version-bump:record` |
| `PROTOCOL_VERSION` bumped with no schema hash change | **fail** `protocol.version_bump.version_without_shape` |

Events: `protocol.version_bump.gate` with `subjectId` / `deviceId` / outcome
(metadata only — never schema field values or learner content).

---

## 4. Deprecation window (concrete)

When a field, enum member, or advisory code is deprecated:

1. **Announce** in the same PR: `CHANGELOG.md` → `### Deprecated`, schema
   description / `x-deprecated` (or equivalent) on the committed JSON Schema,
   and a short note here or in the RFC.
2. **Keep on the wire:** validators **accept** the deprecated item; merges
   **preserve** it; CRDT laws unchanged.
3. **Minimum window before any removal is eligible:** the longer of
   - **180 calendar days** after the dated changelog section that records the
     deprecation, or
   - **two** `PROTOCOL_VERSION` **minor** bumps after that announcement.
4. **Removal** still requires Stage 3 + major `PROTOCOL_VERSION` + freeze RFC
   evidence. Meeting the window alone is **not** permission to remove pre-freeze.

**Observability:** when a deprecated field is present on an inbound document,
implementations **MUST** emit a typed `SyncAdvisory` with code
`DEPRECATED_FIELD_PRESENT` whose `detail` includes `field=…`, `sunset=YYYY-MM-DD`,
and never the field's value (values may be learner-adjacent). Optionally also emit
a structured metadata event
`{"event":"protocol.deprecation","subjectId":"…","deviceId":"…","field":"…","sunsetDate":"…","outcome":"advisory_emitted"}`.
Absence of the field is silent (no advisory). Distinct from validation failure and
from merge anomalies (`CLOCK_SKEW_CLAMPED`, etc.).

**Seeded test-only field:** `profile.__deprTestLegacyLocale` (path
`profile.__deprTestLegacyLocale`, sunset `2027-01-13`) lives in the deprecation
registry to prove advisory emission. It is **not** a production CognitiveState
schema key — parsers collect advisories from the raw payload before schema strip.
See `parseCognitiveStateWithDeprecationAdvisories` / `tests/deprecation_advisory.test.mjs`.

---

## 5. Worked examples

Examples use **real** baseline types from `CognitiveState` / `FrictionSample`.
The additive and deprecate steps are **illustrative playbooks** (not applied in
this PR). The breaking step is explicitly **deferred**.

### Example A — Additive field (allowed now)

**Intent:** Let friction samples optionally name a coarse device class for
routing telemetry (still subject-scoped; no PII).

**Before (baseline `FrictionSample`):** `conceptId`, `hesitationMs`,
`inputVelocity`, `revisionCount`, `assistanceRequested`, `outcome`,
`capturedAt`.

**Change:**

```ts
// Additive — optional; absence means "unspecified"
sourceDeviceClass?: "phone" | "tablet" | "desktop" | "unknown";
```

**Checklist:**

| Step | Action |
|---|---|
| Schema | Add optional property to Zod + Pydantic + `schemas/FrictionSample.json` |
| Version | Bump `PROTOCOL_VERSION` `1.0.0` → `1.1.0` |
| Changelog | `[Unreleased]` → `### Added` bullet for `FrictionSample.sourceDeviceClass` |
| Old clients | Omit the field when writing; ignore it when reading if their parser allows unknowns, or upgrade before accepting `1.1.0` literals |
| Merge | No CRDT change — field rides on the existing friction G-Set element |
| Sovereignty | Enum only; never put raw keystroke or utterance text in this field |

### Example B — Deprecated field (allowed now; remove later)

**Intent:** Prefer BCP-47 `profile.language` alone for locale; stop **writing**
a hypothetical parallel `profile.legacyLocale` that once duplicated it.
(Baseline today has `language` only — this example shows the **deprecate**
machinery against a field that was added additively in a prior minor.)

**Assume** `profile.legacyLocale: string` was added in `1.1.0` and writers
migrated to `language`.

**Change at `1.2.0`:**

1. Mark `profile.legacyLocale` deprecated in schema description + changelog
   `### Deprecated`.
2. Writers **MUST NOT** emit `legacyLocale` on new documents.
3. Readers / merge **MUST** still accept and LWW-preserve it under
   `profile.updatedAt` rules until Stage 3 removal.
4. Emit `DEPRECATED_FIELD_PRESENT` (`SyncAdvisory`) when an inbound doc still
   carries `legacyLocale`, with `sunset=` in `detail`.

**Window:** earliest removal eligibility = max(announce + 180 days, after two
further minors, e.g. announce at `1.2.0` → not before `1.4.0` **and** 180 days).
Actual deletion still waits for Stage 3 major.

### Example C — Breaking change (deferred to Stage 3)

**Intent:** Rename `subjectId` → `learnerId` on `CognitiveState` and envelopes.

**Why this is breaking:** every replica key, auth subject scope, merge guard
(`SUBJECT_MISMATCH`), HTTP path `/v1/subjects/{id}/…`, and idempotent sync
identity keys off `subjectId`. Renaming drops old documents on the floor and
risks cross-wiring subjects if a naive alias is half-applied.

**Pre–Stage 3 response:** **Refuse.** Ship an additive alias only if ever
needed (`learnerId` optional mirror) under Example A rules — never remove
`subjectId`.

**Stage 3 path (sketch only):** freeze RFC + major `PROTOCOL_VERSION` `2.0.0` +
migration advisory + dual-read window longer than §4 + second implementation
proof. Until that RFC is accepted, PRs that rename or remove `subjectId` are
out of policy.

---

## 6. Reviewer checklist (schema PR)

- [ ] Change is additive **or** deprecate-in-place (no removal/rename/type change).
- [ ] `PROTOCOL_VERSION` bumped per §3 when the committed schema changes shape.
- [ ] `[Unreleased]` changelog updated in the same PR.
- [ ] `pnpm protocol:version-bump` green (refresh baseline with
      `pnpm protocol:version-bump:record` after a logged bump).
- [ ] Zod, Pydantic, and `schemas/` regenerated together.
- [ ] Deprecations state the §4 clock start (changelog date) and do not promise
      pre–Stage 3 removal.
- [ ] No raw learner content in examples, advisories, or deprecation logs.
- [ ] Subject isolation unchanged: merge and auth still key on `subjectId`.

---

## 7. What this policy does not cover

- HTTP auth verifier choice (see cloud orchestrator pluggable-auth guide).
- Application-level feature flags unrelated to wire JSON.
- Domain curricula / connector schemas outside `@moolam/sync-protocol`.
