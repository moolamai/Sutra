# Implementor conformance quickstart

Get a green (or actionable red) conformance run against **your** bindings in under **15 minutes** on a clean checkout. This is the Stage 1 implementor path for `@moolam/contract-conformance`: install → point a factory at your implementation → run → read verdicts.

Package reference: [`packages/contract-conformance/README.md`](../../packages/contract-conformance/README.md)  
CI gate (already on `main`): `pnpm conformance` / `pnpm conformance:prove`

## Budget (measured)

| Step | Typical wall time (warm disk, Node 22, pnpm 10.30.3) |
|------|------------------------------------------------------|
| `pnpm install --frozen-lockfile` (clean tree) | 1–4 min (network bound) |
| `pnpm conformance` (build + suite + runtime refs + CLI) | **~15 s** on this repo (measured ~14.9 s) |
| CLI-only smoke after build | **~5 s** (measured ~4.7 s) |

End-to-end on a clean laptop with a warm npm cache stays well under the **15-minute** Stage 1 budget. If install is cold, the clock is install — not the suite.

## 1. Prerequisites

- Node.js **≥ 22**
- pnpm **10.30.3** (see root `packageManager`)
- Git checkout of this repository

```bash
node -v   # v22.x
pnpm -v   # 10.30.3
```

## 2. Install and build

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @moolam/contract-conformance build
```

Build regenerates `packages/contract-conformance/fixtures/wire/bundle.json` from frozen SyncRequest schemas — do not hand-edit that file.

## 3. Smoke the harness (reference implementation)

No custom code yet — prove the CLI and CI gate are healthy:

```bash
# Full gate used by root CI (suite + @moolam/runtime + CLI)
pnpm conformance

# Or CLI-only (subjectId is required — isolation, never raw learner content)
node packages/contract-conformance/bin/conformance.mjs \
  --self-check \
  --subject-id demo-implementor \
  --device-id local \
  --emit-events
```

Exit **0** = all selected obligations passed. Exit **1** = at least one fail / timeout / error.

Human output looks like:

```text
Conformance verdicts
────────────────────
PASS     CK-02.1  MemoryInterface  …  subject=demo-implementor::CK-02.1
PASS     CK-02.3  MemoryInterface  …
────────────────────
2 passed, 0 failed, … — exit 0
```

On failure you will see the **obligation id**, the verbatim **MUST** sentence, and a short message (never raw learner content).

## 4. Point a factory at your implementation

Obligations probe only the public contract surface. You supply a **factory** that returns a fresh harness per obligation run (no shared mutable state between checks).

Minimal memory example (CK-02 durability + subject isolation) — replace the store body with your durable backend:

```js
// scripts/my-memory-conformance.mjs
// Prerequisite: pnpm --filter @moolam/contract-conformance build
import {
  createMemoryDurabilityIsolationRegistry,
  formatHumanReport,
  runConformance,
} from "../packages/contract-conformance/dist/index.js";

/**
 * Factory returns a MemoryConformanceHarness:
 *   - memory: MemoryInterface
 *   - reinstantiate(): new handle onto the SAME durable substrate (crash reopen)
 *   - optional nowMs / setNowMs for decay probes
 */
function createMyMemoryHarnessFactory() {
  // Shared durable map = "disk". Volatile per-handle maps fail CK-02.1.
  const durable = new Map();
  let seq = 0;

  const open = () => ({
    async remember(item) {
      const id = `mem-${++seq}`;
      const row = { ...item, id };
      durable.set(id, row);
      // CK-02.1: flush completed before this promise resolves.
      return row;
    },
    async recall(query) {
      const hits = [];
      for (const item of durable.values()) {
        if (item.subjectId !== query.subjectId) continue;
        hits.push({ item, score: 1 });
      }
      return hits.slice(0, query.limit ?? 16);
    },
    async associate() {},
    async forget(id) {
      durable.delete(id);
    },
    async compact() {
      return 0;
    },
  });

  return () => ({
    memory: open(),
    async reinstantiate() {
      return open();
    },
  });
}

const report = await runConformance({
  registry: createMemoryDurabilityIsolationRegistry(),
  factory: createMyMemoryHarnessFactory(),
  subjectId: "subj-my-impl",
  deviceId: "dev-local",
  emit: (e) => {
    // Structured events: subjectId / deviceId / outcome — never plaintext content
    console.error(JSON.stringify(e));
  },
});

process.stdout.write(formatHumanReport(report));
process.exitCode = report.exitCode;
```

Run:

```bash
node scripts/my-memory-conformance.mjs
```

### Other registries (same pattern)

| Domain | Registry helper | Reference factory (known-good) |
|--------|-----------------|--------------------------------|
| Memory CK-02.* | `createMemoryObligationsRegistry()` | `createDurableMemoryHarnessFactory()` |
| Reasoning CK-04.* | `createReasoningObligationsRegistry()` | (see package tests) |
| Knowledge CK-09.* | `createKnowledgeObligationsRegistry()` | `createCitedKnowledgeHarnessFactory()` |
| Tool CK-07.* | `createToolObligationsRegistry()` | `createWriteAheadToolHarnessFactory()` |
| Model CK-03.* | `createModelObligationsRegistry()` | `createStableModelHarnessFactory()` |
| Speech CK-05.* | `createSpeechObligationsRegistry()` | `createStreamingSpeechHarnessFactory()` |
| Vision CK-06.* | `createVisionObligationsRegistry()` | `createStrictVisionHarnessFactory()` |
| Planning CK-08.* | `createPlanningObligationsRegistry()` | `createCyclicPlanningHarnessFactory()` |
| Runtime RT-01..04 | `createRuntimeObligationsRegistry()` | `createReferenceRuntimeHarnessFactory()` |

Import both the registry and a reference factory from `@moolam/contract-conformance` (workspace: `packages/contract-conformance/dist/index.js`) while you iterate; swap the factory to yours when green against the reference.

## 5. Read verdicts

```js
for (const v of report.verdicts) {
  // v.obligationId  e.g. "CK-02.1"
  // v.mustText       verbatim MUST from @moolam/contracts
  // v.outcome        "pass" | "fail" | "error" | "timeout"
  // v.attribution    "implementation" | "harness"
  // v.message        short reason — metadata tokens only
}
console.log("exitCode", report.exitCode); // 0 green, 1 red (CI aggregate)
```

JSON for tooling:

```bash
node packages/contract-conformance/bin/conformance.mjs \
  --self-check --subject-id demo --json
```

Restrict to one obligation while debugging:

```bash
node packages/contract-conformance/bin/conformance.mjs \
  --self-check --subject-id demo --only CK-02.1
```

## 6. Sovereignty and subject isolation (non-negotiable)

- Every `runConformance` call needs a non-empty **`subjectId`**. The runner scopes probes per subject; cross-subject leakage fails CK-02.3 (and similar isolation obligations).
- Do **not** put raw learner / user content in probe tokens, events, or verdict messages. Use synthetic `probe.*` metadata.
- Declare locality truthfully (`on-device` / `self-hosted` / `external-api`). Locality liars fail model CK-03.3.

## 7. What “red” looks like (expected)

Seed a known-bad implementation path (CI does this automatically):

```bash
pnpm conformance:prove
```

That path:

1. Runs the green gate
2. Runs a **volatile** memory harness → fails **`CK-02.1`** with the durability MUST in the log
3. Re-runs the green gate

If your factory fails, fix the named obligation first — IDs are stable and append-only once published.

## 8. Root CI

The **Protocol & conformance** job (`protocol-conformance`) in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs:

1. `pnpm conformance`
2. `pnpm conformance:prove`
3. Unit checks for the prove helper

A PR that breaks a registered MUST fails the build with the obligation id in the job log.

## Checklist (≤ 15 minutes)

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm conformance` exits 0
- [ ] Factory returns a **fresh** harness per call
- [ ] `runConformance({ subjectId, factory, registry })` prints PASS or a named FAIL
- [ ] Failures show obligation id + MUST; events carry `subjectId` / `deviceId` only

When that checklist is green, your binding is ready for the next contract surface in the table above.
