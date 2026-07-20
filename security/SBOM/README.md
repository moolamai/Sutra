# Release SBOMs (CycloneDX)

| Meta | Value |
|------|-------|
| **Spec** | SEC-02 |
| **Format** | [CycloneDX](https://cyclonedx.org/) 1.5 JSON (`.cdx.json`) |
| **Generator** | `pnpm sbom:generate` — `scripts/generate-release-sbom.mjs` |

Every tagged Sutra release attaches CycloneDX Software Bill of Materials so adopters can verify what dependencies shipped with that release. SBOMs are **generated in CI** by `.github/workflows/release.yml` — never hand-edited on a laptop and never committed as release assets.

## Artifacts produced per release

| File | Contents |
|------|----------|
| `artifacts/sbom/npm-workspace.cdx.json` | Publishable `@moolam/*` packages from `packages/*/package.json` |
| `artifacts/sbom/sutra-sdk-python.cdx.json` | Direct runtime dependencies from `packages/cloud-orchestrator/pyproject.toml` (PyPI `sutra-sdk`) |

On tag publish (`v*`), both files are:

1. Uploaded as workflow artifacts (`actions/upload-artifact`)
2. Attached to the GitHub Release for that tag (`gh release upload … --clobber`)

## Local generation

```bash
pnpm sbom:generate
pnpm sbom:check
```

`sbom:check` asserts the release workflow still generates, uploads, and attaches SBOMs, and that a fresh generate yields valid CycloneDX 1.5 documents.

## Artifact signing (attestation)

SBOMs alone do not prove CI built the bits that landed on a registry. Before **production** npm or PyPI upload, the release workflow runs `pnpm signing:verify -- --mode=production`, which requires:

- **npm provenance attestation** via GitHub OIDC (`PROVENANCE_ENABLED=true` → `NPM_CONFIG_PROVENANCE`)
- **Wheel / pack digests** in `artifacts/release-pack-integrity/manifest.json` (SHA-256 “signatures” of tarballs/wheels recorded before upload)

Unsigned or laptop-published artifacts are refused. See [`docs/sdk/PUBLISH-CHECKLIST.md`](../../docs/sdk/PUBLISH-CHECKLIST.md) for operator commands (`pnpm signing:verify`, `pnpm publish:provenance`, `pnpm publish:integrity:verify`).

## Sovereignty

SBOMs list package names, versions, and Package URLs (purl) only. They never include learner content, prompts, or runtime subject data. Gate events emit `subjectId` / `deviceId` / `outcome` metadata only.
