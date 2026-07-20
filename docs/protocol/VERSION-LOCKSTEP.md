# Version lockstep policy

Cross-language packages that ship the Hybrid Cognitive Sync Protocol must publish
under a **coherent version story** at every `v*` tag: the wire `PROTOCOL_VERSION`
stays aligned across TypeScript and Python, while published npm and PyPI
distribution semvers move together via the changesets fixed group plus manual
PyPI bumps.

**Enforcement:** `pnpm version:lockstep:doc` validates this document against the
repository on every main merge. `pnpm version:lockstep` compares live version
fields and fails CI with a unified diff and offending file paths when they diverge.

## Lockstep invariant

At every tagged release (`v*`), two independent semver groups must each be internally consistent:

| Group | Symbols | Role |
|-------|---------|------|
| **Wire protocol** | `PROTOCOL_VERSION` in TypeScript and Python | Wire contract version on envelopes (`protocolVersion` field) |
| **Distribution** | `sutra-sdk` npm, changesets fixed group, PyPI `pyproject.toml`, Python `__version__` | Published package semver on npm and PyPI |

Python re-exports the wire constant as `sutra_orchestrator.PROTOCOL_VERSION`; it
must match the TypeScript export in `packages/sync-protocol/src/contract.ts`.

Distribution semver may advance (for example `1.1.0`) while the frozen wire
contract remains `1.0.0` until a protocol bump is intentionally released.

**Rule:** PyPI `sutra-sdk` must match the npm `sutra-sdk` / changesets fixed
group version at tag time. A release that bumps npm without bumping
`packages/cloud-orchestrator/pyproject.toml` (ignored by changesets) is invalid.

Do not publish from a laptop; the release workflow is the only publish path.

## Version truth sources

### Wire protocol

| File | Field | Current value (repo baseline) |
|------|-------|-------------------------------|
| [`packages/sync-protocol/src/contract.ts`](../../packages/sync-protocol/src/contract.ts) | `export const PROTOCOL_VERSION` | `1.0.0` |
| [`packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py`](../../packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py) | `PROTOCOL_VERSION` | `1.0.0` |

### Distribution (npm + PyPI)

| File | Field | Current value (repo baseline) |
|------|-------|-------------------------------|
| [`packages/sdk/package.json`](../../packages/sdk/package.json) | `"version"` | `1.1.0` |
| [`packages/sync-protocol/package.json`](../../packages/sync-protocol/package.json) | `"version"` | `1.1.0` |
| [`packages/cloud-orchestrator/pyproject.toml`](../../packages/cloud-orchestrator/pyproject.toml) | `[project] version` | `1.1.0` |
| [`packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py`](../../packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py) | `__version__` | `1.1.0` |

The table reflects the tree at documentation time. Before any publish rehearsal tag,
align each group to a single semver per group (see worked examples below). A mismatch
fails CI via `pnpm version:lockstep`.

## Bump mechanics at release

Release operators follow this order on a `v*` tag push (see
[`.github/workflows/release.yml`](../../.github/workflows/release.yml)):

1. **Changeset version (npm)** — `pnpm changeset:version` bumps every public
   package in the changesets `fixed` group, including `sutra-sdk` and
   `@moolam/sync-protocol`. Cloud orchestrator is **not** an npm package; it is
   listed in `.changeset/config.json` `ignore`.
2. **Align Python distribution version** — set the same distribution semver in:
   - `packages/cloud-orchestrator/pyproject.toml` → `[project] version`
   - `packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py` → `__version__`
3. **Wire constant (when intentionally bumped)** — set the same semver in:
   - `packages/sync-protocol/src/contract.ts` → `PROTOCOL_VERSION`
   - `packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py` → `PROTOCOL_VERSION`
4. **Verify** — `pnpm version:lockstep` and `pnpm pypi:publish:dry-run`
   before tagging; after tag, rehearsal workflows install from scratch npm scope and
   TestPyPI.

Patch/minor distribution bumps use semver as usual. Wire `PROTOCOL_VERSION` changes
only when the contract itself is versioned.

## npm lockstep group

Fourteen public packages share one distribution version via changesets `fixed`
(see [`CHANGELOG.md`](../../CHANGELOG.md)). `sutra-sdk` on npm is the application
entry point; `packages/sdk/package.json` is the canonical distribution version
checked against PyPI.

`sutra-sdk` on PyPI uses the same distribution semver as npm; bump
`pyproject.toml` and `__version__` manually whenever `pnpm changeset:version`
advances the fixed group.

## Worked example — patch release `0.1.0` → `0.1.1`

Assume changesets produced `0.1.1` for the fixed group.

**1. `packages/sdk/package.json`** (already `0.1.1` after `changeset version`)

```json
"version": "0.1.1"
```

**2. `packages/cloud-orchestrator/pyproject.toml`**

```toml
version = "0.1.1"
```

**3. `packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py`**

```python
__version__ = "0.1.1"
```

**4. Tag** — `v0.1.1` or rehearsal `v0.1.1-rehearsal.1` triggers npm + TestPyPI
pipelines with a single coherent distribution version.

## Worked example — P7 coordinated `1.0.0`

At Stage 3 / P7 freeze acceptance, cut **one** semver across ecosystems:

| Location | Value |
|----------|-------|
| `contract.ts` `PROTOCOL_VERSION` | `1.0.0` |
| `@moolam/sync-protocol` / `sutra-sdk` distribution `version` | `1.0.0` |
| `pyproject.toml` / `__version__` | `1.0.0` |
| Release tag | `v1.0.0` |

Production npm and PyPI publish remain gated until P7; rehearsal tags exercise
scratch npm scope and TestPyPI with the same numbers.

## Worked example — distribution `1.1.0` with frozen wire `1.0.0`

| Location | Value |
|----------|-------|
| `contract.ts` / Python `PROTOCOL_VERSION` | `1.0.0` |
| npm fixed group + PyPI `pyproject.toml` / `__version__` | `1.1.0` |
| Release tag | `v1.1.0` |

## Operator checklist

Before requesting a release tag:

- [ ] `pnpm changeset:version` applied (or version bump PR merged)
- [ ] Wire protocol sources share one semver; distribution sources share one semver
- [ ] `packages/cloud-orchestrator/pyproject.toml` matches `packages/sdk/package.json`
- [ ] `pnpm version:lockstep` green (release workflow runs this after the npm bump)
- [ ] `pnpm pypi:publish:dry-run` green
- [ ] `pnpm publish:readiness` and `pnpm publish:pack` green

## Related documents

- [Protocol overview](./README.md)
- [`@moolam/sync-protocol` README](../../packages/sync-protocol/README.md) — wire contract versioning
- [`sutra-sdk` (cloud orchestrator)](../../packages/cloud-orchestrator/README.md) — PyPI distribution; Python import `sutra_orchestrator`
- [Package publish checklist](../sdk/PUBLISH-CHECKLIST.md)
- [Deprecation policy](../../packages/sync-protocol/docs/DEPRECATION-POLICY.md)
