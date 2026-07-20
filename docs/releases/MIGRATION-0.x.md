# Migrating from Sutra 0.x to 1.0

This guide upgrades an existing 0.x integration across the breaking changes in
the frozen 1.0 protocol, contract, pack, certification, and learning surfaces.
Perform the migration in a branch and keep edge and cloud peers on the same
protocol version.

Operator launch copy, India-first positioning, and the Certified Binding
program entry point live in the [1.0 announcement pack](./ANNOUNCEMENT.md)
([CERTIFIED-BINDING.md](../bindings/CERTIFIED-BINDING.md) ·
[field pilot summary](../pilot/PILOT-SUMMARY.md)).

Do not rewrite production state in place without a backup. A 0.x peer and a
1.0 peer intentionally fail closed on their different `protocolVersion`
literals; deploy a coordinated cutover or an explicitly isolated migration
window.

## 1. Toolchain and package upgrade

Sutra 1.0 requires Node.js 22 and pnpm 10.30.3.

```bash
node --version
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm --version
```

For an application using the umbrella SDK:

```bash
pnpm up sutra-sdk@1.0.0
pnpm install --frozen-lockfile
```

Advanced integrations should upgrade every directly imported public package in
one change. Do not mix 0.x and 1.0 `@moolam/*` protocol packages:

```bash
pnpm up \
  @moolam/contracts@1.0.0 \
  @moolam/cognitive-core@1.0.0 \
  @moolam/runtime@1.0.0 \
  @moolam/telemetry@1.0.0 \
  @moolam/sync-protocol@1.0.0
```

Upgrade the Python peer at the same time:

```bash
python -m pip install --upgrade "sutra-sdk==1.0.0"
```

In a Sutra checkout, verify lockstep before continuing:

```bash
pnpm version:lockstep
```

## 2. Cut over the wire protocol

The 1.0 wire marker is an exact literal:

```ts
import { PROTOCOL_VERSION } from "@moolam/sync-protocol";

if (PROTOCOL_VERSION !== "1.0.0") {
  throw new Error(`unexpected Sutra protocol ${PROTOCOL_VERSION}`);
}
```

Update both TypeScript and Python validators, regenerate any derived clients
from the committed 1.0 schemas, and update stored envelope builders to emit
`"1.0.0"`. Validate before any merge or side effect.

Do not:

- replace `"0.x"` with `"1.0.0"` inside an otherwise unvalidated document;
- merge a version-mismatched `CognitiveState`;
- use `deviceId` as authorization for a `subjectId`; or
- retry quarantined payloads indefinitely.

A migration reader may read a bounded, backed-up 0.x snapshot and construct a
new 1.0 document through the 1.0 validators. Preserve subject boundaries,
G-Counter shard values, HLC ordering, and replay identifiers. Quarantine any
record that cannot be mapped without guessing.

Verify the frozen schemas and cross-language behavior:

```bash
pnpm schemas:drift
pnpm golden:joins
pnpm golden:turns
pnpm version:lockstep
```

## 3. Complete `CognitiveBindings`

Planning and tools are required in 1.0. A 0.x composition that delegated these
stages outside the core must bind them explicitly.

Before:

```ts
const bindings = {
  memory,
  model,
  reasoning,
  knowledge,
};
```

After:

```ts
import { CognitiveCore } from "sutra-sdk";

const bindings = {
  memory,
  model,
  reasoning,
  planning,
  tools,
  knowledge,
  // speech and vision remain optional
};

const core = new CognitiveCore(profile, bindings);
```

The core now owns plan/act sequencing. Keep these behavioral requirements:

- serialize overlapping plan updates for one session;
- return typed validation errors for malformed model-emitted tool calls;
- record write-ahead audit before `write` or `critical` effects;
- enforce tool deadlines; and
- make replay idempotent rather than applying an effect twice.

Type-checking is not the acceptance gate. Run the executable contract suite:

```bash
pnpm conformance
```

## 4. Move domain routing to `task-graph.v1`

Replace hardcoded concept maps and router thresholds with a validated pack.
The prerequisite graph must be acyclic, all edge endpoints must exist, and both
thresholds are required.

`@moolam/domain-loader` is workspace-private in 1.0; the import and test command
below apply to source checkouts and embedded distributions. External pack
authors should treat the committed `task-graph-v1.json` schema and equivalent
validator behavior as the contract rather than depending on that package from
a public registry.

```json
{
  "schemaVersion": "task-graph.v1",
  "packId": "teacher-math",
  "domainId": "teacher",
  "version": "1.0.0",
  "title": "Teacher mathematics",
  "description": "Prerequisite graph",
  "thresholds": {
    "advanceThreshold": 0.85,
    "remediateThreshold": 0.4
  },
  "concepts": [
    { "conceptId": "math.fractions", "title": "Fractions", "ageFloor": "child" },
    { "conceptId": "math.ratios", "title": "Ratios", "ageFloor": "child" }
  ],
  "edges": [
    {
      "fromConceptId": "math.ratios",
      "toConceptId": "math.fractions",
      "type": "prerequisite"
    }
  ]
}
```

Load the same bytes in edge and cloud:

```ts
import { loadTaskGraph } from "@moolam/domain-loader";

const graph = loadTaskGraph("./task-graph.json", {
  subjectId: "subject-example",
  deviceId: "device-example",
  onTelemetry: (event) => console.log(event),
});
```

For a monorepo integration, validate schema, DAG behavior, and TypeScript/Python
parity with:

```bash
pnpm --filter @moolam/domain-loader test
```

Do not put learner state in a pack. Packs define domain concepts and routing
policy; runtime state remains scoped by `subjectId`.

## 5. Convert knowledge corpora to pack v1

Each corpus needs a `manifest.json`, one or more content shards, truthful
freshness/locality metadata, and source records that resolve every citation.

```json
{
  "schemaVersion": "bindings-knowledge.pack-v1",
  "packId": "pack.example",
  "version": "1.0.0",
  "title": "Example offline corpus",
  "asOf": "2026-06-01T00:00:00.000Z",
  "builtAt": "2026-07-01T12:00:00.000Z",
  "locality": "bundled-offline",
  "languages": ["en"],
  "sources": [
    {
      "sourceId": "source.example",
      "title": "Example source",
      "domain": "teacher",
      "locality": "bundled-offline",
      "coverage": { "from": "2024-01-01", "to": "2026-06-01" }
    }
  ],
  "contentShards": [
    { "shardId": "shard.example", "relpath": "content/shard.json" }
  ]
}
```

Validate the converted pack and prove offline retrieval:

```bash
pnpm --filter sutra-bindings-knowledge validate-pack -- \
  --pack "$PWD/path/to/pack"
pnpm --filter sutra-bindings-knowledge prove:offline-pack
```

Treat missing citations, post-dated `asOf`, duplicate citations, orphaned
vectors, missing embedding files, and embedding-size mismatches as hard
validation failures.

## 6. Certify every shipped binding

A handwritten compatibility statement or successful compile is not a 1.0
certification. Select an exact registered profile and adapter:

```bash
pnpm --filter sutra-bindings-slm run certify
```

Equivalent explicit desktop invocation:

```bash
pnpm --filter sutra-bindings-slm exec bindings-slm certify \
  --profile desktop \
  --adapter llamacpp
```

Accept the result only when:

- the process exits zero and report `outcome` is `pass`;
- every obligation verdict passes;
- `egressRecord.ok` is true with zero attempts;
- all required performance budgets pass;
- profile, model artifact, and measured hashes agree;
- `subjectId` and `deviceId` are present and isolated; and
- the report contains no prompt, utterance, or other raw-content body.

Certification is profile-specific. Re-certify after adapter, model artifact,
runtime pin, or relevant performance baseline changes.

## 7. Add explicit consent to learning paths

Existing local friction collection does not grant export permission. Introduce
separate active consent records for the operation being performed:

- aggregation consent for cross-boundary friction rollups;
- `trajectory` consent for turn-trajectory capture; and
- `training-export` consent for JSONL export.

Turn trajectories and training rows carry bounded metadata and content hashes.
They must not contain prompts, replies, keystrokes, utterances, tool arguments,
or tool results.

For an explicit, single-subject training export:

```bash
pnpm --filter @moolam/telemetry build
node packages/telemetry/bin/export-trajectories.mjs \
  --store trajectories.jsonl \
  --consent consent.json \
  --subject subject-example \
  --out training.jsonl \
  --limit 1024 \
  --timeout-ms 30000
```

The consent ledger entry must match the selected subject:

```json
[
  {
    "consentRecordId": "consent-export-001",
    "subjectId": "subject-example",
    "scope": "training-export",
    "optedIn": true,
    "active": true
  }
]
```

Never combine subjects in one export. The CLI validates untrusted rows,
deduplicates replayed `turnId` values, and atomically replaces the output only
after complete validation. Missing, denied, expired, wrong-scope, or
cross-subject consent must remain a typed rejection.

See the [training export runbook](../sdk/training-export-runbook.md) before
handing JSONL to an external trainer. `FinetuneJob` is a descriptor only; Sutra
does not upload data, resolve content hashes, or run training.

## 8. Update observability and failure handling

Preserve `subjectId`, `deviceId`, operation outcome, and a typed failure class
on protocol, pack, certification, aggregation, trajectory, and export events.
Never attach learner content or secret values.

Operationally distinct failures must remain distinct:

- schema/version mismatch: reject or quarantine before apply;
- subject mismatch: reject and investigate the storage/query boundary;
- consent failure: reject without persistence or egress;
- queue full or storage timeout: emit the named class, do not block forever;
- partial durable write: recover from write-ahead state; and
- replay: return the existing result without applying a duplicate effect.

## 9. Verify the upgraded integration

From a Sutra checkout, run:

```bash
pnpm version:lockstep
pnpm schemas:drift
pnpm golden:joins
pnpm golden:turns
pnpm conformance
pnpm --filter @moolam/domain-loader test
pnpm --filter sutra-bindings-knowledge test
pnpm --filter @moolam/telemetry test
pnpm guidance:eval
node scripts/launch-checklist.mjs --prove
```

Then run the application-specific restart, concurrent-device, cross-subject,
offline/reconnect, timeout, and replay tests. Do not promote while a gate is
red.

## 10. Rollout and rollback

1. Stop new writes or route them to a bounded migration queue.
2. Back up each subject store and consent ledger independently.
3. Upgrade edge and cloud validators together.
4. Convert and validate a bounded subject cohort.
5. Start 1.0 workers and monitor typed outcomes.
6. Expand only after sync convergence and replay checks pass.

On failure, stop 1.0 writes and restore the matching 0.x application and its
pre-migration snapshot. Do not send 1.0 documents to a 0.x peer and do not
down-label 1.0 state as 0.x. Quarantine partial outputs and investigate by
failure class.

## 11. Release execution gate

The existence of these documents does not authorize publication. Production
release runs only through `.github/workflows/release.yml` after:

1. the cross-track launch checklist is green;
2. the accepted Protocol 1.0 freeze RFC has unlocked the production gate;
3. npm/Python/protocol versions are lockstep;
4. package, integrity, SBOM, signing, and rehearsal gates pass; and
5. the operator explicitly enables the production npm and PyPI repository
   variables.

Never publish production artifacts from a developer laptop.

When the gates are green, distribute the [announcement pack](./ANNOUNCEMENT.md)
alongside these notes — it is the operator-facing link to the Certified Binding
program and field-pilot evidence, not a substitute for the publish checklist.

