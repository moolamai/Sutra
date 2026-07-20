# `@moolam/domain-loader`

Task-graph pack format (v1) and validators for domain intelligence as data.

## What this package does (now)

- Ships `schemas/task-graph-v1.json` — concepts, prerequisite edges, pack-owned advance/remediate thresholds, metadata.
- Ships `validateTaskGraphPack` — JSON Schema + DAG structural checks (self-loops, missing endpoints, cycles with path).

Full load into `TaskRouter` / playground replaces hardcoded demos in later B8 slices.

## Thresholds

Packs must include `thresholds.advanceThreshold` and `thresholds.remediateThreshold`. These are the sole source for consumers (defaults align with cloud router: `0.85` / `0.40`).

## Load paths

```ts
import { loadTaskGraph } from "@moolam/domain-loader";

const graph = loadTaskGraph("./fixtures/golden-packs/valid-dag.json", {
  subjectId: "subj.example",
  deviceId: "dev-1",
  onTelemetry: (e) => console.log(e),
});
// graph.nodes / graph.versionStamp — router + playground shape
```

Python (cloud-orchestrator):

```python
from sutra_orchestrator.domain_graph_loader import load_task_graph

meta = load_task_graph("packages/domain-loader/fixtures/golden-packs/valid-dag.json")
# meta.graph → TaskGraph; meta.version_stamp for operators
```

Both loaders consume the same pack file bytes and expose matching semantics fingerprints.


Committed corpus under `fixtures/golden-packs/` (valid DAG, cyclic reject, missing-node reject, self-loop). Run with:

```ts
import { runGoldenPackSuite } from "@moolam/domain-loader";

const suite = runGoldenPackSuite({
  subjectId: "subj.ci",
  deviceId: "ci",
  onTelemetry: (e) => console.log(e),
});
```

## Validate

```ts
import { validateGraph, validateTaskGraphPack } from "@moolam/domain-loader";

// DAG gate — Kahn topo on success; ordered cyclePath on cycle/self-loop.
const dag = validateGraph(
  { concepts, edges },
  { subjectId: "subj.example", deviceId: "dev-1", onTelemetry: (e) => console.log(e) },
);

const packResult = validateTaskGraphPack(packJson, {
  subjectId: "subj.example",
  deviceId: "dev-1",
  onTelemetry: (e) => console.log(e),
});
```

Telemetry events include `subjectId`, `deviceId`, outcome, and distinct `failureClass` — never concept titles or learner content.
