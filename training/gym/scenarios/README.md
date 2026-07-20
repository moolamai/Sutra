# Unified scenario catalog

Indexes A P6 golden + B8 guidance scenarios with slice tags.
Committed as `catalog.json` (language-neutral).

## Commands

```bash
pnpm --filter @moolam/training-gym catalog:write   # materialize (human review)
pnpm --filter @moolam/training-gym catalog:check   # byte-identical gate
pnpm --filter @moolam/training-gym catalog:smoke   # one seeded episode per slice
```

Smoke failures always name `scenarioId` and `slice`.
