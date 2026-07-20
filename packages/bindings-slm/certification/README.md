# Binding certification artifacts

| Path | Role |
|------|------|
| `registry.json` | Profile registry — CLI `--profile` ids: `desktop`, `android-mid` (alias `android`), `apple-silicon` |
| `schemas/certification.report.schema.json` | Versioned report schema (`bindings-slm.certification.report.v1`) |
| `*.profile.json` | Per-adapter certification profiles |
| `reports/certification.report.json` | Latest unified harness report (desktop) |

Report fields (required): `adapter`, `modelArtifactSha256`, `obligationVerdicts`, `egressRecord`, `p95Benches`, `subjectId` / `deviceId`. Never utterance bodies.
