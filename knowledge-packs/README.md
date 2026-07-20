# Knowledge packs (data root)

Versioned **knowledge-pack** artifacts live here as data — never as TypeScript imports from `domains/`.

| Layer | Role |
|-------|------|
| `domains/{teacher,doctor,…}/` | Markdown domain specs (source of truth for authors) |
| `knowledge-packs/` | Built pack trees (manifest + content shards + optional vectors) |
| `sutra-bindings-knowledge` | Format schemas + Zod validators (and later: pack loader) |

## Pack v1 layout

```
knowledge-packs/<packId>/
  manifest.json          # id, version, asOf, builtAt, languages, sources[], contentShards[]
  content/
    shard-001.json       # passages[] — each with resolvable citation + asOf
  vectors/
    id-map.json          # optional: passageId → vectorIndex (+ dimensions/dtype for full layer)
    embeddings.bin       # optional: float32 LE row-major; byte length = rows × dims × 4
```

Validate before ship:

```bash
pnpm --filter sutra-bindings-knowledge validate-pack -- --pack ./knowledge-packs/<packId>
```

Invariants:

- Every passage citation MUST resolve through the pack manifest `sources[]` table.
- `asOf` is stamped at build time and must not postdate `builtAt` / the check clock.
- `bundled-offline` packs are served with network denied (loader slice).
- Optional vector id-map rows MUST reference cited passageIds present in content (orphan rows fail at build).
- When `dimensions` + `dtype` are set on the id map, `embeddings.bin` is required and must match entry count × dimensions × dtype width; every `vectorIndex` must uniquely address a row.

Schema + fixtures for the format: `packages/bindings-knowledge/schemas/pack-v1.json` and `packages/bindings-knowledge/fixtures/pack-v1/`.

## Committed packs

| Pack | Path | Source | Consumers |
|------|------|--------|-----------|
| Teacher CBSE maths slice | `knowledge-packs/teacher-cbse-slice/` | `domains/teacher/data/cbse-syllabus-slice.md` (+ `provenance.json`) | `examples/teacher-basic` via `PackKnowledgeConnector` |
| Doctor formulary sketch | `knowledge-packs/doctor-formulary-sketch/` | `domains/doctor/data/formulary-sketch.md` (+ `provenance.json`) | `loadDoctorFormularySketchConnector` (disclaimers in citation locators) |

```bash
pnpm --filter sutra-bindings-knowledge build:pack -- --pack teacher-cbse-slice --built-at 2026-07-01T12:00:00.000Z
pnpm --filter sutra-bindings-knowledge build:pack -- --pack doctor-formulary-sketch --built-at 2026-07-01T12:00:00.000Z
pnpm --filter sutra-bindings-knowledge check:pack
pnpm --filter sutra-bindings-knowledge validate-pack -- --pack ./knowledge-packs/teacher-cbse-slice
pnpm --filter sutra-bindings-knowledge validate-pack -- --pack ./knowledge-packs/doctor-formulary-sketch
pnpm --filter @moolam/examples teacher-basic
```

Rebuild after editing domain markdown; `check:pack` / CI job `knowledge-flagship-packs` fail when a domains/ fingerprint drifts from `provenance.json`.

```bash
pnpm --filter sutra-bindings-knowledge run ci:flagship-packs
pnpm --filter sutra-bindings-knowledge run ci:prove:flagship-packs
```

