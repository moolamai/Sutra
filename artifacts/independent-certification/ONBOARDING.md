# Independent implementor onboarding (CERTRUN-001)

## Recruit / commission

| Field | Value |
|-------|-------|
| Implementor id | `indep-cert-2026-07` |
| Commissioned | 2026-07-17 |
| Support channel | Independence kit + this artifact only — **no monorepo access** |
| Storage stack | File-backed JSONL (`src/storage.mjs`) — not shipped in reference packages |
| Model stack | Deterministic on-device probe (`src/model.mjs`) — not `sutra-bindings-*` |

## Deliver to the implementor

1. Packed `@moolam/contract-conformance` (or registry install)
2. Extracted `fixtures/independence-kit.tgz`
3. [`docs/protocol/CERTIFICATION-CHECKLIST.md`](../../docs/protocol/CERTIFICATION-CHECKLIST.md)
4. This tree (`artifacts/independent-certification/`) as their starter factory

Do **not** share `packages/` checkout paths, internal design chats, or reference binding source.

## Execute

```bash
node scripts/run-certification.mjs \
  --subject-id cert.indep.a \
  --device-id ext-ci-1
```

Artifacts:

- `reports/environment-manifest.json` — runtime + stack attestation
- `reports/certification-report.json` — per-obligation pass/fail (metadata only)

## Findings hand-off

Pass/fail verdicts and any waivers feed
[`rfcs/0001-protocol-1.0-freeze.md`](../../rfcs/0001-protocol-1.0-freeze.md)
(incorporation + 1.0.0 publish is the next certification-run slice).
