# Docs site ownership

| Tree | Owner | Rule |
|------|-------|------|
| `docs/` (repo root) | Authors / maintainers | **Canonical** markdown. Edit here only. |
| `docs-site/reference/` | Sync script | **Generated mirror** of curated `docs/` paths. Do not hand-edit. |
| `docs-site/index.md`, `docs-site/.vitepress/`, `docs-site/src/quickstarts/` | Docs-site maintainers | Site chrome (nav, sidebar, landing, quickstart landing pages). |
| `docs-site/api/` | TypeDoc (`pnpm docs:api`) | **Generated** from `packages/*/dist/*.d.ts` (SDK barrel + re-exports). Never hand-edit. |

## Sync map

| Source (`docs/`) | Destination (`docs-site/reference/`) |
|------------------|--------------------------------------|
| `OVERVIEW.md` | `overview.md` |
| `architecture/**` | `architecture/**` |
| `protocol/**` | `protocol/**` |
| `sdk/**` | `sdk/**` |

Run `pnpm docs:sync` (also runs before `docs:build` / `docs:dev`).

Sync skips `node_modules`, VCS metadata, and similar non-doc trees so diagram tooling under `docs/architecture/` does not inflate the site mirror.

## API reference

| Source | Destination |
|--------|-------------|
| `packages/{sdk,contracts,cognitive-core,runtime,telemetry,sync-protocol,edge-agent}/dist/index.d.ts` | `docs-site/api/**` (TypeDoc markdown) |

`pnpm docs:api` (and `docs:build`) fail when declarations are missing or stale versus package `src/`. A `.fingerprint` of the input `.d.ts` files is written so CI can detect drift versus dist.

## Sovereignty note

The public site must never publish raw learner/user content. Sync only copies committed governance and protocol docs from `docs/` — no runtime subject payloads. API pages document public TypeScript surfaces only.
