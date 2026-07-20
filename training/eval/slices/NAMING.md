# Eval slice naming (gate reports)

Frozen eval slices are addressed by three dimensions:

| Dimension | Field | Meaning |
|-----------|-------|---------|
| Domain pack | `domainPackId` | Pack / lane (e.g. `teacher`, `lawyer`, `protocol`, `smoke`) |
| Language | `language` | BCP-47-ish tag (e.g. `en`) — never utterance text |
| Binding | `bindingId` | Surface / binding (e.g. `edge`, `b8`, `a-p6`, `protocol`) |

## Slice id

```text
{domainPackId}/{language}/{bindingId}
```

Examples used in gate reports as `failingSlice`:

- `smoke/en/edge`
- `protocol/en/a-p6`
- `teacher/en/b8`
- `lawyer/en/b8`

Use only the slash form in automation and telemetry. Do not embed raw learner content in slice ids.

## Registry mapping

Baseline registry `sliceTags` map as:

- `sliceTags.domainPack` → `domainPackId`
- `sliceTags.language` → `language`
- `sliceTags.binding` → `bindingId`

## Empty markers

A domain pack with zero guidance (or other) evals still appears in `taxonomy.json` with `emptyMarker: true`. Gates that reference such a slice fail the gate-definition linter — they must not be silently skipped.

## Per-slice runners

Suite reports always include `slices[]` (one score per slice id). The `aggregate` block is derived from those scores and must never be the only metric. Stochastic components receive an injected pinned-seed RNG — see `runner-policy.json`.

## CI coverage

`pnpm --filter @moolam/learning slices:check` fails when a registered domain pack or binding lacks a frozen slice with baselines. The report lists `missingSliceIds` by slash-form name.
