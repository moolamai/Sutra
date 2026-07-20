# `@moolam/runtime-harness`

Runtime harness core for Sutra companions. Hosts the streaming turn protocol
using frozen A P6 harness frames from `@moolam/sync-protocol`.

## Status

`StreamingTurnHost` has typed emit helpers per A P6 frame kind, a monotonic
`sequenceIndex` allocator, `terminateWithError` / `runGuarded` for terminal
HARNESS_ERROR, and `InMemoryStreamFrameBuffer` indexed by `sequenceIndex`.
Last-Event-ID resume (`parseLastEventId` / `resolveStreamResume`) replays from
the buffer or emits a SEQUENCE_GAP frame with `RESYNC_REQUIRED`. Integration
coverage: disconnect after frame 5 → resume 6..N, and gap fixture index 99.
`ToolCallParser` is an incremental mode state machine (thought / answer /
tool_buffer / violation) with pure `feed()` events. Declared tags are held as
fragments across chunk boundaries (`PARSER_DECLARED_TAGS` + offset fuzz).
`terminateDeadline()` discards open fences / held tags without hanging.
A P6 golden-turn fixtures are imported under `fixtures/golden-turns/`
(`loadGoldenTurnCorpus` / `pnpm golden:sync`). Replay with canonical diff:
`pnpm golden:replay` (`replayGoldenTurn`). Chunk-boundary fuzz CI:
`pnpm golden:fuzz` (prove: `pnpm golden:fuzz:prove`). Malformed-fence
regression goldens (CK-07): `pnpm golden:malformed`.

**Golden replay operator workflow** (sync → review diff → land when A P6
changes): [docs/golden-replay-operator.md](./docs/golden-replay-operator.md).
`SandboxSeam` + `InProcessFakeToolRegistry` isolate tool effects (deadline,
write-ahead ack, result-schema validation → TOOL_STATUS / tool_response).

## A P6 schema

- Types / Zod: `@moolam/sync-protocol` (`harnessFrameSchema`)
- Committed JSON Schema: `packages/sync-protocol/schemas/HarnessFrame.json`
  (`A_P6_HARNESS_FRAME_SCHEMA_PATH`)

## Last-Event-ID resume (client)

SSE `id:` equals the frame `sequenceIndex` (decimal). On reconnect:

1. Send `Last-Event-ID: <last seen sequenceIndex>`.
2. Host outcome `action: "replay"`: lossless re-delivery of buffered frames with
   `sequenceIndex > N`. **Attach only** — do not restart in-flight tools or
   re-apply side effects; duplicate Last-Event-ID is idempotent.
3. Host outcome `action: "gap"`: terminal `HARNESS_ERROR` with
   `code: SEQUENCE_GAP` and message advisory `RESYNC_REQUIRED` (empty buffer,
   eviction hole, never-issued index, or invalid header). Open a **new** turn
   (full resync); do not retry the same Last-Event-ID forever.
4. Absent Last-Event-ID → `action: "fresh"` (new stream open).
5. Cross-subject / stream mismatch → `action: "reject"` (no frame leakage).

## Anti-cheat charter (training)

`training/gym` must **import this package** — never re-implement the parser,
sandbox, or correction loop. Binding governance:

**[training/gym/charter.md](../../training/gym/charter.md)**

Replay parity (byte-identical canonical frame sequences) is enforced by
`pnpm --filter @moolam/training-gym parity:check` and the gym unit suite.

## Scripts

```bash
pnpm --filter @moolam/runtime-harness build
pnpm --filter @moolam/runtime-harness test
pnpm --filter @moolam/runtime-harness golden:sync
pnpm --filter @moolam/runtime-harness golden:check
pnpm --filter @moolam/runtime-harness golden:replay
pnpm --filter @moolam/runtime-harness golden:fuzz
pnpm --filter @moolam/runtime-harness golden:malformed
pnpm --filter @moolam/training-gym parity:check
pnpm --filter @moolam/training-gym test
```

See [docs/golden-replay-operator.md](./docs/golden-replay-operator.md) for the
full sync / review / merge checklist.
