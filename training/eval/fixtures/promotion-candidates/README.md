# Promotion candidate manifests (one-surgery gate)

Language-neutral JSON fixtures for constitution L1:

- `ok-adapter-only.json` — single `adapter` surgery (must pass lint)
- `violation-multi-surgery.json` — `adapter` + `critic` (must fail `attribution_void`)

Gate: `pnpm --filter @moolam/learning surgery:check`
