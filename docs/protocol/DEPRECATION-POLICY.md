# Post-1.0 protocol evolution guide

This is the implementor runbook for evolving a client, binding, or independent
server after the Hybrid Cognitive Sync Protocol 1.0 freeze. Normative evolution
rules live with the wire package:

**[`packages/sync-protocol/docs/DEPRECATION-POLICY.md`](../../packages/sync-protocol/docs/DEPRECATION-POLICY.md)**

That policy defines additive-only evolution, `PROTOCOL_VERSION` bump semantics,
the CI gate (`pnpm protocol:version-bump`), the 180-day / two-minor deprecation
window, and the `DEPRECATED_FIELD_PRESENT` advisory. This guide explains how an
implementor applies those rules without weakening subject isolation, replay
idempotency, or locality.

> Current repository artifacts still use wire version `0.1.0`. The rules below
> govern published 1.x artifacts after the freeze RFC is accepted and 1.0.0 is
> released; they do not claim that the draft freeze is already accepted.

## 1. Read `PROTOCOL_VERSION` before state processing

Treat every wire document as untrusted input. Read only the top-level
`protocolVersion` discriminator first, compare it with the schema bundle your
implementation has installed, then run the full validator. Do not merge,
persist, route, or inspect learner-adjacent fields before that validation
succeeds.

| Incoming version | Implementor action |
|---|---|
| Missing, malformed, or not a supported literal | Reject or quarantine with a typed `PROTOCOL_VERSION_INVALID` / schema-validation failure. Do not retry indefinitely. |
| Exact supported version | Parse the complete envelope and continue. |
| Same major, newer minor | Fail closed and upgrade the schema bundle before accepting it. A newer minor is additive, but a literal-pinned validator does not silently adopt unknown wire data. |
| Same major, older minor | Use an explicitly tested migration adapter or an older parser. Never relabel the document by rewriting only `protocolVersion`. |
| Different major | Reject with a distinct incompatible-major failure and follow the migration guide shipped with that major. |

Example boundary logic (illustrative; use the generated validator in real
code):

```ts
const version = readTopLevelProtocolVersion(untrustedJson);
if (version !== SUPPORTED_PROTOCOL_VERSION) {
  return quarantine({
    code: "PROTOCOL_VERSION_UNSUPPORTED",
    receivedVersion: version,
    supportedVersion: SUPPORTED_PROTOCOL_VERSION,
  });
}
return syncRequestSchema.parse(untrustedJson);
```

The diagnostic contains version metadata only. It must not include the
document, utterances, profile values, or friction samples.

## 2. Handle additive minor releases

An additive 1.x release may add an optional field, enum member, union variant,
or advisory code. It must not remove, rename, narrow, or repurpose an existing
1.x contract.

Worked example: 1.1 adds optional
`FrictionSample.sourceDeviceClass: "phone" | "tablet" | "desktop" | "unknown"`.

1. Upgrade both generated schema bindings and the conformance fixture bundle.
2. Keep writers able to omit the field until all required peers understand
   1.1.
3. Define behavior when the field is absent (`"unspecified"` in this example).
4. Test old-document → new-parser round trips and replay the same
   `syncAttemptId` twice; the second application must not add evidence again.
5. Deploy readers before writers when a mixed-version migration is required.

Do not use an unknown-field stripping parser as a compatibility strategy unless
the published contract explicitly permits it. Stripping can destroy data when a
newer document later returns to a newer peer.

## 3. Handle deprecated fields

A deprecated field remains valid throughout its published window. Readers keep
accepting and preserving it; writers stop creating it once their replacement is
available.

When a registered deprecated field is present:

1. Parse advisories from the raw envelope before an unknown-key stripping step.
2. Emit one `SyncAdvisory` with code `DEPRECATED_FIELD_PRESENT`.
3. Include the field path and `sunset=YYYY-MM-DD` in `detail`.
4. Never include the field's value in the advisory or telemetry.
5. Continue normal validated processing until the announced removal major.

The reference seeded proof uses
`profile.__deprTestLegacyLocale` with sunset `2027-01-13`. It is test-only and
is not a production `CognitiveState` field. A production deprecation uses the
same advisory shape:

```json
{
  "code": "DEPRECATED_FIELD_PRESENT",
  "detail": "field=profile.legacyLocale;sunset=2028-06-30;replacement=profile.language"
}
```

Absence is silent. Replaying the same payload may reproduce the same advisory,
but must not mutate state twice. Advisory collection is bounded by the
published registry and must not scan unrelated subject histories.

## 4. Plan and execute a migration

Use this sequence for every protocol minor:

1. **Inventory** — record each deployed peer's supported protocol versions,
   schema-bundle digest, and locality. Store identifiers and aggregate counts,
   not learner content.
2. **Read release evidence** — review `[Unreleased]` / the released changelog,
   committed schemas, conformance obligations, deprecations, sunset dates, and
   the wire-shape diff.
3. **Prepare readers** — install the new literal-pinned parser and migration
   adapters. Test malformed versions, older-minor input, newer-minor rejection,
   and a different-major rejection.
4. **Prove isolation** — run fixtures for at least two distinct `subjectId`
   values and verify no read, write, advisory, retry, or quarantine record is
   cross-wired. `deviceId` is correlation metadata, not authorization.
5. **Canary without writes** — validate sampled metadata at the declared
   locality boundary. Keep result sets, retry counts, and advisory collection
   bounded.
6. **Deploy readers before writers** — only begin emitting the new minor after
   every required receiving tier can validate it.
7. **Observe and roll back safely** — alert on typed version failures and
   deprecation counts. Roll back writers first. Preserve `syncAttemptId` so
   retries after partial failure remain idempotent.
8. **Retire deprecated writes** — keep reads until the later of 180 days, two
   subsequent minor bumps, and the authorized removal major.

Concurrent updates for one subject still use the protocol's CRDT/HLC merge
rules; a migration must not introduce a separate read-modify-write path. A
timeout or partial failure returns a typed outcome. It is never silently
retried with a new idempotency key.

## 5. Breaking changes and 2.0

Removing or renaming a field, changing its type or meaning, narrowing accepted
input, or changing replay semantics is breaking. For example,
`subjectId` → `learnerId` cannot ship in 1.x: subject identity scopes storage,
authorization, merge guards, audit records, and HTTP resources.

A breaking release requires:

- a new major `PROTOCOL_VERSION`;
- an accepted evolution RFC and a published migration guide;
- dual-read or explicit conversion fixtures where safe;
- conformance evidence from the reference and independent implementations;
- a rollback plan that does not mix major versions in one merge operation.

Never infer subject identity from `deviceId`, and never alias two subject IDs
during migration.

## 6. Observability and safe diagnostics

Emit structured, metadata-only outcomes. Recommended event classes:

```json
{"event":"protocol.version_check","subjectId":"subject-ref","deviceId":"edge-ref","receivedVersion":"1.1.0","supportedVersion":"1.0.0","outcome":"rejected_newer_minor"}
{"event":"protocol.deprecation","subjectId":"subject-ref","deviceId":"edge-ref","field":"profile.legacyLocale","sunsetDate":"2028-06-30","outcome":"advisory_emitted"}
{"event":"protocol.migration","subjectId":"subject-ref","deviceId":"edge-ref","fromVersion":"1.0.0","toVersion":"1.1.0","outcome":"validated"}
```

Use stable failure classes for malformed version, unsupported minor,
incompatible major, schema violation, subject mismatch, and migration-adapter
failure. Metrics may aggregate those classes and deprecated field paths. Logs
must never carry field values, complete payloads, prompts, model output, raw
learner content, or cross-subject state.

## 7. Release checklist for implementors

- [ ] Pin the protocol package and generated schema bundle to one version.
- [ ] Verify the package changelog and schema diff for every upgrade.
- [ ] Reject unsupported literals before merge or persistence.
- [ ] Preserve unknown additive data where the contract requires round trips.
- [ ] Stop writing deprecated fields; keep reading them through the window.
- [ ] Surface `DEPRECATED_FIELD_PRESENT` with path + sunset, never value.
- [ ] Test replay, partial failure, concurrency, and two-subject isolation.
- [ ] Keep migration scans, advisories, and retries bounded.
- [ ] Emit metadata-only version, deprecation, and migration outcomes.
- [ ] Require a migration guide and accepted RFC before adopting a new major.
