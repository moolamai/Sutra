# Sutra 1.0 announcement pack

Operator-facing launch copy for Sutra 1.0.0. Use this pack when announcing the
freeze, onboarding companion builders, or pointing third parties at the
Certified Binding program. It does not authorize publication by itself —
production release still runs only through `.github/workflows/release.yml`
after the cross-track launch checklist and the accepted Protocol 1.0 freeze
RFC are green.

Companion documents:

| Document | Role |
|----------|------|
| [1.0.0 release notes](./1.0.0.md) | What shipped and what broke from 0.x |
| [0.x → 1.0 migration guide](./MIGRATION-0.x.md) | Copy-paste upgrade steps |
| [Certified Binding program](../bindings/CERTIFIED-BINDING.md) | Badge criteria and one-command certify |
| [Field pilot summary](../pilot/PILOT-SUMMARY.md) | India classroom / mid-range device evidence |
| [Binding certification guide](../sdk/binding-certification-guide.md) | Pass/fail reading of certify reports |
| [Publish checklist](../sdk/PUBLISH-CHECKLIST.md) | Operator release gates |

## Headline

**Sutra 1.0 — sovereign cognitive infrastructure for India-first companions.**

Frozen protocol. Executable contracts. Certified on-device bindings. Domain
intelligence as versioned data. Consent-gated learning seams. One loop on the
edge and in the cloud.

## India-first positioning

Sutra 1.0 is designed for companions that must work where connectivity is
intermittent, devices are mid-range Android phones, and languages are Indic
first — not English-only cloud demos.

Concrete 1.0 surfaces that support that positioning:

| Surface | What operators get | Evidence |
|---------|--------------------|----------|
| Mid-range Android ONNX profile | Certified `onnx` · `android-mid` binding with zero-egress `generate`/`embed` | [CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md) §4.2 · committed `android.cert.json` |
| Apple silicon MLX profile | Certified `mlx` · `apple-silicon` binding for field-pilot matrix peers | Registry + committed `apple-silicon.cert.json` |
| Indic speech | Streaming STT partials; classroom-noise fixture closed as `FP-002` | [PILOT-SUMMARY.md](../pilot/PILOT-SUMMARY.md) · `hi-classroom-noise` |
| Teacher CBSE pack | Bundled-offline knowledge + task-graph pack for Class 8 ratios slice | `knowledge-packs/teacher-cbse-slice/` · pilot pack `teacher-cbse-slice@1.0.0` |
| Offline sync | Write-ahead friction samples survive offline/restart; replay is idempotent | Pilot finding `FP-001` (Closed) |
| Sovereignty | Every read/write scoped by `subjectId`; no raw keystrokes or utterances on wire | Pilot exit sign-off `FP-004` · B9 consent scopes |

Field pilot window (2026-07-02 → 2026-07-16) ran the kit-minimum matrix
`android-mid` + `apple-silicon` against the teacher CBSE slice. All four
findings (`FP-001`…`FP-004`) are Closed. Trajectory export stayed off during
the pilot (`trajectoryExport: false`); B9 now owns consent-gated export.

## Operator one-pager

### What 1.0 is

- A frozen Hybrid Cognitive Sync Protocol at `PROTOCOL_VERSION = "1.0.0"`.
- Nine public cognitive contracts with executable obligation IDs.
- A complete `CognitiveCore` loop: perceive → recall → retrieve → reason →
  plan/act → respond → reflect.
- Certified local model, speech, vision, and knowledge bindings.
- Task-graph and knowledge packs loaded as validated data — never imported
  from `domains/` into kernel packages.
- Consent-gated aggregation, trajectory capture, and training-export seams
  that never embed prompt, reply, keystroke, or utterance bodies.

### What 1.0 is not

- A managed fine-tuning service — `FinetuneJob` is a handoff descriptor only.
- Permission to display a Certified Binding mark without a green committed
  report for that exact `(adapter, profile)` pair.
- A laptop publish path — production npm/PyPI upload is CI-only after freeze
  unlock.

### Who this is for

| Persona | Start here |
|---------|------------|
| Companion builder | `sutra-sdk` + [migration guide](./MIGRATION-0.x.md) |
| Binding author | [CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md) + certify CLI |
| Domain expert | `task-graph.v1` + `bindings-knowledge.pack-v1` packs |
| Safety / ops reviewer | [PILOT-SUMMARY.md](../pilot/PILOT-SUMMARY.md) · launch checklist · publish checklist |

## Certified Binding program (required link)

Third-party and in-repo adapters enter the ecosystem only through the
Certified Binding program. Authoritative governance:

**→ [docs/bindings/CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md)**

One command answers “is this adapter safe to ship?”:

```bash
pnpm --filter sutra-bindings-slm exec node ./bin/bindings-slm.mjs certify \
  --profile <profile> \
  --adapter <adapter>
```

Shipped 1.0 profiles (registry ids):

| Profile | Adapter | Hardware | Badge subtitle |
|---------|---------|----------|----------------|
| `desktop` | `llamacpp` | cpu | `llamacpp · desktop` |
| `android-mid` | `onnx` | mid-range-android | `onnx · android` / `android-mid` |
| `apple-silicon` | `mlx` | apple-silicon | `mlx · apple-silicon` |

### Worked green excerpt (desktop — real committed report)

Source:
`packages/bindings-slm/certification/reports/certification.report.json`

```json
{
  "schemaVersion": "bindings-slm.certification.report.v1",
  "outcome": "pass",
  "profileId": "desktop",
  "adapter": "llamacpp",
  "subjectId": "cert.desktop.llamacpp",
  "deviceId": "ci-desktop-cpu",
  "obligationVerdicts": [
    { "obligationId": "CK-03.1", "outcome": "pass" },
    { "obligationId": "CK-03.2", "outcome": "pass" },
    { "obligationId": "CK-03.3", "outcome": "pass" }
  ],
  "egressRecord": { "ok": true, "attemptCount": 0 },
  "failures": []
}
```

### Badge rules operators must enforce

- Display **Certified Binding** only when badge criteria B1–B9 hold on the
  committed report (see CERTIFIED-BINDING.md §3).
- Subtitle must be `{adapter} · {profileId}` from the report — never marketing
  copy alone.
- Forbidden: badging a red report, a report missing `subjectId`/`deviceId`, or
  a report that embeds utterance/prompt bodies.
- Re-running certify is idempotent; concurrent certifies for different subjects
  must not cross-contaminate identity fields.
- Partial failure after the first durable report write remains red until a full
  green report exists.

Pass/fail reading guide: [binding-certification-guide.md](../sdk/binding-certification-guide.md).

## Field pilot evidence (required link)

**→ [docs/pilot/PILOT-SUMMARY.md](../pilot/PILOT-SUMMARY.md)**

| Finding | Severity | Disposition |
|---------|----------|-------------|
| `FP-001` offline Android sync gap | P2 | Closed — write-ahead + idempotent `markSynced` |
| `FP-002` Indic STT classroom noise | P1 | Closed — `hi-classroom-noise` fixture |
| `FP-003` routing guidance parity | P3 | Closed — guidance-eval held |
| `FP-004` privacy / exit sign-off | P3 | Closed — no raw content export |

Edge cases the pilot already exercised (and operators must keep green):

- Device offline entire window → samples stay `synced=0`; reconnect is
  idempotent.
- Restart mid-operation → pre-submit discard; post-write-ahead survival.
- Two devices → distinct `subjectId`×`deviceId`; same-subject dual-device
  rejected.
- Replayed sync → never double-applied.
- Observability events carry `subjectId`, `deviceId`, and named failure
  classes — never raw learner content.

## Sovereignty and subject isolation (launch copy)

Use this wording consistently in announcements and operator briefings:

1. Every cognitive read and write is scoped by `subjectId`. Cross-subject
   access is a defect, not a feature gap.
2. `deviceId` is correlation metadata, not an authorization substitute.
3. Regulated and learner content stay inside the declared `on-device` /
   `self-hosted` locality boundary unless a separate, explicit consent scope
   authorizes movement.
4. Model output and wire payloads are untrusted input — validate at the
   boundary before use.
5. Aggregation, trajectory capture, and training export require active,
   subject-matching consent for their own scopes. Existing local friction
   collection does not grant export permission.
6. Telemetry and certification reports are metadata-only. Forbidden keys
   include raw keystrokes, prompts, utterances, transcripts, and tool bodies.

## Concurrent turns, partial failure, and replay

Announce these as non-negotiable runtime properties — not aspirational goals:

| Case | Required behavior |
|------|-------------------|
| Concurrent turns for the same `subjectId` | Plan-stage serialization; no lost updates from racing read-modify-write |
| Partial failure after first durable side effect | Recover from write-ahead / quarantine; never pretend the operation completed |
| Replayed sync or duplicated request | Idempotent apply — same `syncAttemptId` / `turnId` never double-counts |
| Downstream timeout | Typed, named failure class to the caller — never an unhandled rejection |
| Validation failure | Typed contract / obligation error naming the violated check |

## Suggested short copy blocks

### Social / blog (≈120 words)

Sutra 1.0 freezes the Hybrid Cognitive Sync Protocol and the public cognitive
contracts that third parties can implement without reading the reference
source. Companions share one loop on mid-range Android, Apple silicon, and
desktop — with Indic speech, offline knowledge packs, and a Certified Binding
program that proves conformance, zero-egress locality, and performance in a
single command. A two-week India field pilot on the teacher CBSE slice closed
offline sync, classroom-noise STT, routing parity, and privacy sign-off.
Learning exports stay consent-gated and metadata-only: raw keystrokes never
leave the sovereign boundary. Start with the release notes, migration guide,
and [Certified Binding checklist](../bindings/CERTIFIED-BINDING.md).

### Internal ops blurb

Do not cut `v1.0.0` until `node scripts/launch-checklist.mjs` (cross-track
green), `pnpm production-publish:gate`, and the publish checklist are green.
Announcement assets live under `docs/releases/`. Badge claims must cite a
committed report path from the bindings-slm registry.

## Release gate reminder

This announcement pack is prepared for the A P5 publish pipeline. Execution
still requires:

1. Cross-track launch checklist green.
2. Accepted Protocol 1.0 freeze RFC and unlocked production publish gate.
3. Lockstep npm / PyPI / `PROTOCOL_VERSION` at `1.0.0`.
4. Integrity, SBOM, signing, and rehearsal gates green.
5. Explicit production registry variables — never a laptop publish.

### Tag rehearsal (post P7 freeze)

Operators rehearse the cut before tagging production:

```text
node scripts/launch-checklist.mjs          # cross-track-green
pnpm production-publish:gate               # P7 freeze unlock
pnpm release:tag-rehearsal                 # P5 dry-run + signed release record
```

The rehearsal verifies release docs land, `release.yml` wires
cross-track-green → changeset publish dry-run, public packages are inventory-
green, and signs [`RELEASE-RECORD-1.0.0.json`](./RELEASE-RECORD-1.0.0.json).
Replaying the same operation id is idempotent and never double-applies the
record. Release executes only after cross-track-green and A P7 freeze merge.

See [1.0.0 release notes](./1.0.0.md) · [migration guide](./MIGRATION-0.x.md) ·
[publish checklist](../sdk/PUBLISH-CHECKLIST.md).
