# Golden-turn fixtures (A P6 import)

Byte-for-byte copies of committed A P6 goldens from
`packages/sync-protocol/fixtures/golden-turns`.

**Operator workflow (sync, review diff, land updates):**
[docs/golden-replay-operator.md](../../docs/golden-replay-operator.md)

- **Do not hand-edit** `expectedFrames` or reorder keys.
- Sync from upstream: `pnpm --filter @moolam/runtime-harness golden:sync`
- Check parity (CI): `pnpm --filter @moolam/runtime-harness golden:check`
- Updates require **human review** before commit — the sync script never
  auto-commits.
- B4-only malformed-fence goldens live in [`malformed-fence/`](./malformed-fence/)
  (not part of the A P6 sync corpus).

Loader: `src/golden_turn_loader.ts` (shared by parser replay / fuzz suites).
