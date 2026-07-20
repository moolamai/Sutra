# Golden task-graph packs

Committed packs for `validateTaskGraphPack` / `validateGraph` outcomes.

| Case | File | Expect |
|------|------|--------|
| valid DAG | `valid-dag.json` | status 0 |
| cyclic reject | `cyclic-reject.json` | `cycle` + ordered `cyclePath` |
| missing-node reject | `missing-node-reject.json` | `missing_edge_endpoint` |
| self-loop reject | `self-loop-reject.json` | `self_loop` (length-1 cycle) |

Parity fingerprint for `valid-dag.json`: `valid-dag.semantics.json` (TS + Python must match).

`manifest.json` is the catalog. Update cases only with human review — do not invent learner content; titles are synthetic domain labels only.

Load / run: `loadGoldenPackManifest`, `runGoldenPackSuite` from `@moolam/domain-loader`.
