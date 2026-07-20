# Independent certification — second implementor

This tree is the **commissioned independent implementor** for Track A P7
certification-run. It is deliberately **not** the Sutra reference stack:

| Surface | This implementor | Forbidden (reference monorepo) |
|---------|------------------|--------------------------------|
| Storage | File-backed JSONL under `data/` (subject-scoped) | `@moolam` memory/sqlite bindings, in-tree edge stores |
| Model | Deterministic on-device probe model in `src/model.mjs` | `sutra-bindings-slm`, llama.cpp / ONNX / MLX adapters |

Support materials are the **independence kit only** (`@moolam/contract-conformance`
pack + `fixtures/independence-kit.tgz` +
[`CERTIFICATION-CHECKLIST.md`](../../docs/protocol/CERTIFICATION-CHECKLIST.md)).
No Sutra monorepo checkout is required on the implementor machine.

## Onboarding

1. Deliver packed `@moolam/contract-conformance` (or registry install) + this tree.
2. Extract kit fixtures: `tar -xzf …/independence-kit.tgz -C ./kit`
3. Verify kit: `node …/conformance-cli.mjs verify --kit ./kit`
4. Run certification: `node scripts/run-certification.mjs`
5. Collect `reports/environment-manifest.json` + `reports/certification-report.json`

## Commands

```bash
# From repo (CI / maintainer prove):
node artifacts/independent-certification/scripts/run-certification.mjs
node --test artifacts/independent-certification/tests/certification_run.test.mjs
pnpm certification:run:prove
```

## Sovereignty

Reports and logs carry `subjectId` / `deviceId` / obligation ids / outcomes only —
never utterance or prompt bodies.
