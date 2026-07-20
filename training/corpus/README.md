# Training corpus factory

Versioned **corpus manifests** and a deterministic builder under `training/corpus/`.

| Artifact | Role |
|----------|------|
| `manifest_schema.json` | JSON Schema (sources, filters, lanes, MEM/UND/RET, consent, dedup slot, license ledger) |
| `build.ts` | Zod validate-on-write + deterministic builder (`buildCorpusFromManifest`) |
| `mix_policy.ts` | Training mix policy machine mirror, manifest linter, ratification / promotion version bind ([docs/learning/MIX_POLICY.md](../../docs/learning/MIX_POLICY.md)) |
| `domain_packs/` | Per-pack SFT lanes, curriculum ordering, and SLM size/quality gate (hundreds-not-thousands + critic floor + lane size reports) |
| `scripts/build-corpus.mjs` | CLI: `--manifest` → `--out` shards + `build-report.json` |
| `fixtures/` | Golden manifest + JSONL sources |

```bash
pnpm --filter @moolam/training-corpus test
pnpm --filter @moolam/training-corpus prove:mix-policy
pnpm --filter @moolam/training-corpus build:corpus -- --manifest ./fixtures/valid/minimal.json --out ./tmp-out
```

Invariants:

- `weightTrainingPolicy.excludeKnowledgeModes` must include `RET`
- RET sources emit under `retrieve/` only — never `weight/`
- Mix policy lint: MEM thin (≤ 0.15), repair-heavy ~50% ± 0.05 when repair sources present — see [MIX_POLICY.md](../../docs/learning/MIX_POLICY.md)
- Unknown license / hash mismatch / eval contamination → hard build failure
- Two builds from the same manifest produce byte-identical shard trees
