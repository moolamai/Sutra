# Sutra docs site

VitePress static site for strangers browsing Sutra. Content is mirrored from the canonical `docs/` tree — see [OWNERSHIP.md](./OWNERSHIP.md). API reference is generated from `sutra-sdk` and re-exported package declarations via TypeDoc.

## Commands

```bash
pnpm install
# Build package dist/*.d.ts first (from repo root):
#   pnpm --filter sutra-sdk... build
pnpm docs:sync    # copy curated docs/ → reference/
pnpm docs:api     # TypeDoc → api/ (fails on missing/stale declarations)
pnpm docs:dev     # local preview
pnpm docs:build   # sync + api + VitePress → .vitepress/dist
```

From the monorepo root:

```bash
pnpm docs-site:sync
pnpm docs-site:api
pnpm docs-site:build
pnpm docs-site:check
```

## Scope

- Nav / sidebar / markdown pipeline for Overview, Architecture, Protocol, SDK
- Generated API reference under `/api/` (never hand-maintained)
- Quickstart landing pages under `src/quickstarts/` (canonical guides live in `docs/sdk/`: implementor, conformance stub, binding certification)
