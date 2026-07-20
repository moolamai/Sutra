# `sutra-bindings-knowledge`

Versioned knowledge-pack format + bundled-offline pack loader for `KnowledgeConnectorInterface`.

| Artifact | Path |
|----------|------|
| JSON Schema | `schemas/pack-v1.json` |
| Validators | `pack_format.ts` / `pack_validator.ts` / `validate-pack` CLI |
| Pack loader | `pack_loader.ts` — `PackKnowledgeConnector` (`retrieve` + `describe`) |
| Fixtures | `fixtures/pack-v1/` |

`PackKnowledgeConnector.load(packRoot)` validates the pack, then:
- `describe()` → `bundled-offline` (or declared locality) + truthful pack `asOf` + `sources`
- `retrieve()` → keyword (+ optional vector re-rank); every hit carries a citation resolvable via `describe().sources`
- Offline prove → `proveOfflinePackRetrieve` (B1 egress deny + CK-09.2)
- Teacher example → `loadTeacherCbseSliceConnector` + `proveTeacherPackCognitiveCore` (`knowledge-packs/teacher-cbse-slice/`)
- Flagship authoring → `scripts/build_pack.mjs --pack teacher-cbse-slice|doctor-formulary-sketch` (filesystem only) → pack + `provenance.json`
- Doctor formulary → `loadDoctorFormularySketchConnector` (disclaimers in citation `Source tier:` locators; title is non-advisory)

```bash
pnpm --filter sutra-bindings-knowledge test
pnpm --filter sutra-bindings-knowledge build:pack -- --pack doctor-formulary-sketch --built-at 2026-07-01T12:00:00.000Z
pnpm --filter sutra-bindings-knowledge check:pack
pnpm --filter sutra-bindings-knowledge prove:offline-pack
pnpm --filter sutra-bindings-knowledge prove:teacher-pack
pnpm --filter @moolam/examples teacher-basic
pnpm --filter sutra-bindings-knowledge run ci:flagship-packs
pnpm --filter sutra-bindings-knowledge run ci:prove:flagship-packs
pnpm --filter sutra-bindings-knowledge validate-pack -- --pack ./knowledge-packs/doctor-formulary-sketch
```

Telemetry: `bindings_knowledge.pack_loader` / `pack_format` — `subjectId` / `deviceId` / `outcome`; never raw query or passage text.

