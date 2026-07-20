# Certification findings triage (DIST-01)

Machine-readable companion: [`certification-findings.json`](./certification-findings.json).

| Finding | Severity | Status | Disposition |
|---------|----------|--------|-------------|
| `CERTRUN-F-001` | P3 | **Closed** | Independent checklist suite 10/10 pass (non-reference storage + model) |
| `CERTRUN-F-002` | P3 | **Closed** | Independent SyncRequest producer emits schema-locked `protocolVersion` |
| `CERTRUN-F-003` | P2 | **Waived** (Track A lead · 2026-10-01) | Full 34-id catalog remains reference-green; DIST-01 bar is checklist + independent stacks |
| `FP-002` | P1 | **Closed** | `hi-classroom-noise` Indic fixture + `fp002_classroom_noise.test.mjs` |

No finding embeds raw learner content. Events and reports carry `subjectId` /
`deviceId` / obligation ids only.
