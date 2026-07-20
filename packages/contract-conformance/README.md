# @moolam/contract-conformance

Standalone executable conformance harness for `@moolam/contracts` MUST
clauses: obligation registry, deadlined runner, human/JSON reports, CLI, and
per-contract suites (wire, memory, reasoning, knowledge, tools, model, speech,
vision, planning, runtime). The published package runs against an installed
external implementation without a Sutra monorepo checkout.

## Implementor quickstart

**Start here:** [`docs/sdk/conformance-quickstart.md`](../../docs/sdk/conformance-quickstart.md)

Install → point a factory at your implementation → run → read verdicts. Aimed at
the Stage 1 **&lt; 15 minute** clean-checkout budget. Root CI runs the same gate
via `pnpm conformance`.

## Commands

```bash
# Full CI gate: build, package suite, @moolam/runtime refs, CLI self-check
pnpm conformance

# Green → seeded CK-02.1 red (obligation id + MUST in log) → green
pnpm conformance:prove

# Package unit suite only
pnpm --filter @moolam/contract-conformance test

# CLI smoke (subjectId required)
pnpm --filter @moolam/contract-conformance build
node packages/contract-conformance/bin/conformance.mjs \
  --self-check --subject-id demo --device-id local

# Published-package path from an independent project
npx @moolam/contract-conformance \
  --factory ./conformance-factory.mjs \
  --subject-id synthetic-certification \
  --device-id external-ci \
  --only CK-02.1,CK-02.3
```

## External factory contract

The CLI owns the published obligations and runs each selected MUST in a fresh
subject namespace with a per-obligation deadline. Your ESM module returns the
harness needed by the current `obligationId`:

```js
// conformance-factory.mjs
export default async function factory({ subjectId, obligationId, signal }) {
  // Return a fresh harness. Switch by obligationId when certifying more than
  // one contract surface. Do not put learner content in setup errors or logs.
  return createMyHarness({ subjectId, obligationId, signal });
}

export async function teardown(harness, context) {
  await harness.close?.(context.signal);
}
```

Relative paths resolve from the caller's working directory; installed package
specifiers are also accepted. `--only` is optional and defaults to the bounded
published catalog. A missing export, setup error, timeout, failed MUST, or
teardown error exits 1. Reports always name the obligation ID and verbatim MUST
text; unexpected implementation error strings are redacted so raw user content
cannot leak into CI logs.

## Scaffold

| Export | Role |
|---|---|
| `Obligation<T>` | Stable id, contract name, verbatim MUST text, specIds, async `check` |
| `ObligationContext` | Isolated `subjectId`, deadline, emit hook (no raw content) |
| `ObligationViolation` | Typed fail for a single obligation |
| `ObligationRegistry` | Append-only register, `select`, `groupByContract`, `exportCatalogJson` |
| `runConformance` | Fresh factory per obligation, deadline (default 5s), CI `exitCode` |
| `formatHumanReport` / `formatJsonReport` | Pass/fail table (MUST on failure) or JSON |
| `conformance` bin | `--factory <module> --subject-id <id> [--only …] [--json]`; `--self-check` smoke |
| Wire / memory / … registries | See quickstart registry table |

Build regenerates `fixtures/wire/bundle.json` from
`packages/sync-protocol/schemas` + wire-parity golden (never hand-written shapes),
then bundles P0/P6 sync fixtures + [`CERTIFICATION-CHECKLIST.md`](../../docs/protocol/CERTIFICATION-CHECKLIST.md)
into `fixtures/independence-kit/` and `fixtures/independence-kit.tgz` for
external implementors (no monorepo checkout).

```bash
# After install / pack extract:
tar -xzf node_modules/@moolam/contract-conformance/fixtures/independence-kit.tgz -C ./kit
node tools/conformance-cli/bin/conformance-cli.mjs verify --kit ./kit
pnpm independence-kit:prove   # pack → scratch extract → verify (CI)
```

Obligation IDs are append-only once published. Duplicate registration throws
`DuplicateObligationIdError`. `mustText` must include the verbatim MUST sentence
from `@moolam/contracts`.

## Tests

```bash
pnpm --filter @moolam/contract-conformance test
```
