# Conformance guide — obligation CLI against a stub

Run `@moolam/contract-conformance` against a **stub** factory: install the harness, smoke the CLI, wire a minimal memory stub, read pass/fail verdicts.

**Verified:** 2026-07-16 · Node.js 22 · pnpm 10.30.3 · clean machine with a Sutra checkout (for the harness package) or a packed `@moolam/contract-conformance` install.

> Companion path for app scaffolding (install → turn → sync): [implementor-quickstart.md](./implementor-quickstart.md).  
> Broader contract-surface table (monorepo contributor notes): [conformance-quickstart.md](./conformance-quickstart.md).

## What “green” means

| Signal | Meaning |
|--------|---------|
| Process exit **0** | Every selected obligation `outcome` is `pass` |
| Process exit **1** | At least one `fail` / `error` / `timeout` — fix the **named** obligation id first |
| Human report line | `PASS` or `FAIL` + `obligationId` + short message (never raw learner content) |
| Structured event | `subjectId`, `deviceId`, `outcome` only |

## 1. Prerequisites

```bash
node -v   # v22.x
pnpm -v   # 10.30.3
```

Install the conformance package (published semver when live; otherwise from a Sutra release pack / workspace):

```bash
pnpm add -D @moolam/contract-conformance
# or from a Sutra checkout root:
#   pnpm install --frozen-lockfile
#   pnpm --filter @moolam/contract-conformance build
```

The CLI binary name is **`conformance`** (package bin). Prefer:

```bash
pnpm exec conformance --help
# root CI alias when developing inside Sutra:
pnpm conformance
```

Do **not** hard-code deep `packages/.../src/...` paths in your app — import from `@moolam/contract-conformance`.

## 2. Smoke the CLI (reference / self-check)

```bash
pnpm exec conformance \
  --self-check \
  --subject-id demo-stub \
  --device-id local \
  --emit-events
```

- `--subject-id` is **required** (subject isolation).
- `--emit-events` prints JSON lines with `subjectId` / `deviceId` / outcome — never utterance bodies.
- Exit **0** = harness healthy. Exit **1** = investigate the first failing obligation id.

Restrict while debugging:

```bash
pnpm exec conformance --self-check --subject-id demo-stub --only CK-02.1
```

JSON for tooling:

```bash
pnpm exec conformance --self-check --subject-id demo-stub --json
```

## 3. Stub implementation (memory durability + isolation)

Obligations probe the public contract surface. Supply a **factory** that returns a **fresh** harness per call (no shared mutable handles across overlapping runs — concurrent probes for the same `subjectId` must not race on one handle).

Save as `scripts/stub-memory-conformance.mjs` in **your** project:

```js
import {
  createMemoryDurabilityIsolationRegistry,
  formatHumanReport,
  runConformance,
} from "@moolam/contract-conformance";

/**
 * Stub MemoryInterface: durable Map = "disk".
 * Volatile per-handle maps fail CK-02.1 (durability).
 * Cross-subject recall fails CK-02.3 (isolation).
 */
function createStubMemoryHarnessFactory() {
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

const subjectId = process.env.SUTRA_SUBJECT_ID ?? "subj-stub";
const deviceId = process.env.SUTRA_DEVICE_ID ?? "dev-local";

const report = await runConformance({
  registry: createMemoryDurabilityIsolationRegistry(),
  factory: createStubMemoryHarnessFactory(),
  subjectId,
  deviceId,
  emit: (e) => {
    process.stderr.write(`${JSON.stringify(e)}\n`);
  },
});

process.stdout.write(formatHumanReport(report));
process.exitCode = report.exitCode;
```

```bash
node scripts/stub-memory-conformance.mjs
```

### Failure modes (stub / runner)

| Case | Expected behavior |
|------|-------------------|
| Empty `subjectId` | Runner / factory rejects — typed failure, named obligation or validation error |
| Volatile “disk” (Map per handle) | `CK-02.1` **fail** with durability MUST text |
| Cross-subject recall | `CK-02.3` **fail** (isolation) |
| Downstream timeout | Verdict `outcome: "timeout"` — never silent catch-and-continue |
| Partial failure mid-suite | Aggregate exit **1**; earlier durable stub writes stay — re-run is idempotent for probes (synthetic `probe.*` tokens only) |
| Concurrent factories sharing one handle | Race → flaky fails; always return a fresh harness per factory call |

## 4. Read pass / fail

```js
for (const v of report.verdicts) {
  // v.obligationId  e.g. "CK-02.1"
  // v.mustText       verbatim MUST
  // v.outcome        "pass" | "fail" | "error" | "timeout"
  // v.message        short reason — metadata only
}
// report.exitCode === 0 green, 1 red
```

Seed a known-red path inside Sutra CI with `pnpm conformance:prove` (volatile memory → fails `CK-02.1`, then green again).

## 5. Sovereignty

- Scope every probe by `subjectId`. Cross-subject access is a defect.
- Never put raw learner / user content in probe tokens, events, or verdict messages — use synthetic `probe.*` metadata.
- Declare locality truthfully (`on-device` / `self-hosted` / `external-api`). Locality lies fail model `CK-03.3`.

## 6. Next: certify a model binding

When the stub is green, certify a real model / speech / vision adapter:

→ **[Binding certification guide](./binding-certification-guide.md)** — conformance (B0 / CK-03) + locality (B1) suites and pass/fail interpretation.  
→ **[Certified Binding checklist](../bindings/CERTIFIED-BINDING.md)** — badge criteria B1–B9 tied to report fields.

## Checklist

- [ ] `pnpm exec conformance --self-check --subject-id …` exits 0
- [ ] Stub factory returns a fresh harness per call
- [ ] `runConformance` prints PASS or a named FAIL
- [ ] Events carry `subjectId` / `deviceId` only
- [ ] Binding certification guide bookmarked before shipping an adapter
