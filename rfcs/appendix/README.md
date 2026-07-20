# Freeze RFC evidence appendices

Generated and gated artifacts that attach to
[`rfcs/0001-protocol-1.0-freeze.md`](../0001-protocol-1.0-freeze.md).

| Artifact | Command | Gate |
|----------|---------|------|
| [`conformance-coverage.md`](./conformance-coverage.md) / [`.json`](./conformance-coverage.json) | `pnpm conformance:coverage` | `pnpm conformance:coverage:check` |
| [`production-publish-gate.json`](./production-publish-gate.json) | `pnpm production-publish:gate -- --write` | `pnpm production-publish:gate` |
| [`certification-findings.md`](./certification-findings.md) / [`.json`](./certification-findings.json) | independent cert triage | `pnpm certification:freeze:prove` |

Reports are metadata only: obligation IDs, outcomes, suite paths, unlock flags, `subjectId`, and `deviceId`. Never raw learner content.

Production registries unlock only when `production-publish-gate.json` has `"unlocked": true` (RFC Accepted + maintainer sign-off + no blocking issues). Tag `v1.0.0` to execute `.github/workflows/release.yml` production publish.
