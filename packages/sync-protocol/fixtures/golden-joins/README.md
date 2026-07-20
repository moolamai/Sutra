# Golden joins corpus

Language-neutral `(stateA, stateB, expectedJoin)` triples shared by the
TypeScript and Python CRDT merge suites.

## Invariants

- Plain JSON with canonical (sorted) object keys.
- No language-specific serialization artifacts.
- Updating any golden file requires **human review**.
- `scripts/generate-golden-joins.mjs` regenerates `expectedJoin` from the
  TS `CrdtHarnessResolver` but **never auto-commits**.

## Coverage

| kind | What it proves |
|------|----------------|
| `shard-max` | G-Counter pointwise max (incl. `toString` shard ids) |
| `friction-union` / `friction-collision` | G-Set union + deterministic collision prefer |
| `lww-equal-hlc` | LWW registers under equal physical+logical HLC ties |
| `state-vector` | Pointwise HLC max |
| `compaction` | `compactedSampleTimestamps` handshake / prune remerge |
| `idempotent` | `merge(a,a) ≡ a` |
| `subject-isolation` | Cross-subject merge refused |

## Load path

Both consumers read the same directory:

`packages/sync-protocol/fixtures/golden-joins/`

## CI gate

The `golden-joins` GitHub Actions job runs both consumers and
`pnpm golden:joins:prove` (seeded `expectedJoin` drift → red with
`GOLDEN_JOIN_MISMATCH` + case id → revert → green). Regeneration still
never auto-commits; prove always restores the seeded fixture.
