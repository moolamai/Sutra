# Harness stream semantics — reconnect, replay, and `sequenceIndex`

Normative rules for consumers of the streaming harness frame union
(`HarnessFrame`). Track B's parser and any stranger implementor must obey
these rules; incidental provider ordering is never protocol truth.

**Wire schema:** [`packages/sync-protocol/schemas/HarnessFrame.json`](../../packages/sync-protocol/schemas/HarnessFrame.json)
· Zod/TS: `harnessFrameSchema` / `assertMonotonicSequence` in
`packages/sync-protocol/src/harness_frames.ts`
· Pydantic: `HarnessFrame` / `assert_monotonic_sequence` in
`sutra_orchestrator.contract_models`
· Golden frames: [`packages/sync-protocol/fixtures/wire-parity/harness-frames.json`](../../packages/sync-protocol/fixtures/wire-parity/harness-frames.json)

---

## 1. What a stream is

Cognition moves as a sequence of **typed frames**, never raw provider
tokens. Every variant carries:

| Field | Rule |
|---|---|
| `type` | Discriminant — one of the eight frozen members below |
| `sequenceIndex` | Non-negative integer; contiguous within a session stream |
| `correlationId` | Opaque id for the streaming connection / turn series |
| `subjectId` | Subject scope — empty string is invalid; cross-subject frames on one connection are a defect |

Frame types (additive evolution only — new types are new members, never renames):

`SESSION_START` · `THOUGHT_DELTA` · `ANSWER_DELTA` · `TOOL_STATUS` ·
`ADVISORY_ATTACH` · `METER_TICK` · `TURN_COMPLETE` · `HARNESS_ERROR`

Streams are opened under auth and **scoped to one `subjectId`**. A frame
whose `subjectId` differs from the connection's subject must be rejected
before any local state is touched.

---

## 2. `sequenceIndex` monotonicity

Within a single session stream (same `correlationId` + `subjectId` after
`SESSION_START`):

1. Indices form a contiguous integer sequence: `n, n+1, n+2, …`
2. The first frame after open is typically `SESSION_START` at `0` (see golden fixture).
3. Clients **must not** assume network delivery order. Out-of-order arrival
   is reconciled by `sequenceIndex`, never by wall clock or provider chunk order.
4. Duplicates (`sequenceIndex` already applied) are **idempotent no-ops** —
   never double-apply deltas or tool-status transitions.
5. Gaps (`expected` ≠ `actual`) are never silently skipped.

### Worked example — contiguous happy path

From the golden fixture (`subjectId = "anika-k"`, `correlationId = "corr-1"`):

```json
[
  { "type": "SESSION_START", "sequenceIndex": 0, "subjectId": "anika-k", "correlationId": "corr-1" },
  { "type": "THOUGHT_DELTA", "sequenceIndex": 1, "subjectId": "anika-k", "correlationId": "corr-1" },
  { "type": "ANSWER_DELTA",  "sequenceIndex": 2, "subjectId": "anika-k", "correlationId": "corr-1" }
]
```

`assertMonotonicSequence` / `assert_monotonic_sequence` returns `{ ok: true }`.

### Worked example — gap detection

After indices `0, 1`, a frame arrives with `sequenceIndex: 99`:

```ts
assertMonotonicSequence([
  { sequenceIndex: 0, subjectId: "anika-k" },
  { sequenceIndex: 1, subjectId: "anika-k" },
  { sequenceIndex: 99, subjectId: "anika-k" },
]);
// → { ok: false, code: "SEQUENCE_GAP", subjectId: "anika-k", expected: 2, actual: 99 }
```

The consumer MUST treat this as a hard stream anomaly: either enter the
**reconnect / replay** protocol (§3) or surface a terminal `HARNESS_ERROR`
(§4). Silent skip or "best effort" concatenation is non-conformant.

---

## 3. Reconnect and last-seen replay

When the transport drops mid-turn, the client reconnects with a
**last-seen** cursor. Replay must be lossless or explicitly gapped —
never a silently shortened transcript.

### Client state (minimum)

| Field | Meaning |
|---|---|
| `subjectId` | Binding subject for the stream (unchanged across reconnect) |
| `correlationId` | Prefer reuse of the interrupted series when the server still holds it |
| `lastSeenSequenceIndex` | Highest contiguous index the client has applied |

### Reconnect request (conceptual)

```
OPEN stream
  subjectId=<bound>
  correlationId=<prior or new>
  lastSeenSequenceIndex=<N>   // client has applied 0..N inclusive
```

### Server obligations

1. **Auth + subject scope at open** — refuse foreign `subjectId`.
2. If the server can resume the same series:
   - Replay every durable frame with `sequenceIndex > N` in order, **or**
   - If any index `> N` was lost and cannot be reconstructed, emit a single
     `HARNESS_ERROR` with `code: "SEQUENCE_GAP"` (or equivalent documented
     code), `recoverable: true|false` per §4, and do **not** continue the
     stream as if nothing happened.
3. If the series is gone (server restart without buffer), emit
   `HARNESS_ERROR` with a non-recoverable gap/session-lost code; the client
   starts a new `SESSION_START` (new `correlationId`, `sequenceIndex` from `0`).
4. Replayed frames are byte-identical to the originals for durable fields.
   Clients apply them with the same idempotence rule as live frames
   (duplicate `sequenceIndex` → no-op).

### Worked example — lossless resume

Client applied through `sequenceIndex: 3` (`TOOL_STATUS`). Reconnect with
`lastSeenSequenceIndex = 3`. Server resumes:

```json
[
  { "type": "ADVISORY_ATTACH", "sequenceIndex": 4, "subjectId": "anika-k", "correlationId": "corr-1" },
  { "type": "METER_TICK", "sequenceIndex": 5, "subjectId": "anika-k", "correlationId": "corr-1" },
  { "type": "TURN_COMPLETE", "sequenceIndex": 6, "subjectId": "anika-k", "correlationId": "corr-1", "turnId": "turn-1" }
]
```

Client next-expected was `4`; after apply, last-seen is `6`. No gap.

### Worked example — explicit gap after resume

Client reconnects with `lastSeenSequenceIndex = 2`. Server can only resume
from durable index `5` (frames `3` and `4` lost):

```json
{
  "type": "HARNESS_ERROR",
  "sequenceIndex": 3,
  "correlationId": "corr-1",
  "subjectId": "anika-k",
  "code": "SEQUENCE_GAP",
  "message": "missing frames 3..4; resume buffer truncated",
  "recoverable": false
}
```

Client MUST NOT invent filler deltas. Operators see
`failureClass` / `code = SEQUENCE_GAP` with `subjectId` — never thought/answer text.

### Bounded replay

Replay buffers are size- and time-bounded. Unbounded "replay everything"
scans are out of budget (NFR bounded retries / result sets). When the
buffer is exhausted, prefer a typed `HARNESS_ERROR` over partial silent
replay.

---

## 4. `HARNESS_ERROR` terminal rules

`HARNESS_ERROR` is a first-class frame. A truncated or failed stream ends
with a typed error — never a silent stall.

| Field | Meaning |
|---|---|
| `code` | Stable machine token (e.g. `SEQUENCE_GAP`, `STREAM_TRUNCATED`) |
| `message` | Human/operator greppable text — **not** learner utterance content |
| `recoverable` | `true` → client may reconnect with last-seen; `false` → start a new session |

### Terminal vs non-terminal

- After `HARNESS_ERROR` with `recoverable: false`, the stream is **closed**.
  Further frames on that `correlationId` are ignored.
- After `HARNESS_ERROR` with `recoverable: true`, the client MAY reconnect
  (§3). The error frame itself still advances `sequenceIndex` so the series
  stays contiguous.
- `TURN_COMPLETE` is the happy-path terminal. A stream that ends without
  `TURN_COMPLETE` or `HARNESS_ERROR` is non-conformant producer behavior;
  consumers treat it as truncation and synthesize local handling (e.g. surface
  timeout) without inventing deltas.

### Worked example — recoverable truncation

From the golden fixture (index `7`):

```json
{
  "type": "HARNESS_ERROR",
  "sequenceIndex": 7,
  "correlationId": "corr-1",
  "subjectId": "anika-k",
  "code": "STREAM_TRUNCATED",
  "message": "peer closed before TURN_COMPLETE",
  "recoverable": true
}
```

Client may reopen with `lastSeenSequenceIndex = 7` (or `6` if the error was
not applied). Duplicate delivery of this error frame is idempotent.

---

## 5. Concurrency, races, and idempotence

- **Concurrent turns** for the same `subjectId` (two `correlationId`s) must
  not share a `sequenceIndex` space. Each stream is its own monotonic series.
  Cognitive-state merges (sync CRDT) remain subject-scoped and commutative;
  stream frames do **not** replace the CRDT algebra.
- **Partial failure** after the first durable side effect (e.g. tool started,
  meter tick stored): still emit a terminal frame (`TURN_COMPLETE` or
  `HARNESS_ERROR`). Never leave the peer waiting without a terminal.
- **Replayed / duplicated frames** (same `sequenceIndex` + `correlationId` +
  `subjectId`): apply once. Second delivery is a no-op. Never double-append
  answer deltas or double-fire tool success.

---

## 6. Sovereignty and observability

- Validate every frame at the wire boundary (`harnessFrameSchema` /
  `HarnessFrame.model_validate`) — parse, never cast.
- Telemetry for parse / sequence outcomes carries `subjectId`, optional
  `deviceId`, `outcome`, and failure class (`SEQUENCE_GAP`,
  `missing_subject`, `unrecognized_keys`, …). **Never** thought/answer
  `delta` text or raw meter prompt content in plaintext signals.
- Distinct failure classes get distinct signals; silent catch-and-continue
  is forbidden.

`parseHarnessFrame` / `parse_harness_frame` return metadata-only rejected
outcomes for instrumentation; hosts map those to spans/events without
logging frame payloads wholesale.

---

## 7. Implementor checklist

- [ ] Every emitted/consumed frame includes `type`, `sequenceIndex`,
      `correlationId`, `subjectId`.
- [ ] Client tracks contiguous last-seen and rejects gaps via `SEQUENCE_GAP`
      or reconnect protocol — never silent skip.
- [ ] Reconnect sends `lastSeenSequenceIndex`; server replays losslessly or
      emits typed `HARNESS_ERROR`.
- [ ] Duplicate `sequenceIndex` is idempotent.
- [ ] Stream ends with `TURN_COMPLETE` or `HARNESS_ERROR`.
- [ ] Cross-subject frames are rejected at open / parse.
- [ ] Observability events omit raw deltas.
