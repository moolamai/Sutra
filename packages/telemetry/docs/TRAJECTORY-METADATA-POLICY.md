# Turn trajectory metadata policy

`TurnTrajectoryV1` records how a turn ran without recording what the person
typed, said, saw, or received. It is suitable for quality analysis only after
schema validation and an explicit, subject-matched export-consent check.

The governing contract is `turnTrajectoryV1Schema` in
`@moolam/sync-protocol`. The committed JSON Schema is
[`TurnTrajectoryV1.json`](../../sync-protocol/schemas/TurnTrajectoryV1.json).
The telemetry package's broader privacy invariant is documented in
[`README.md`](../README.md#contributing-notes).

## Captured and forbidden data

Captured metadata:

- identity and routing: `trajectoryFormatVersion`, `turnId`, `subjectId`,
  `deviceId`, optional `sessionId`, `capturedAt`, and `locality`;
- consent reference: `consentRecordId` (a reference, not the consent-vault
  contents);
- bounded stage records: stage name, status, chunk index, operation code, and
  optional HLC start/end timestamps;
- bounded tool-call records: call id, tool name, status, argument/result
  hashes, and optional byte lengths;
- turn outcome, model id, prompt/response hashes, and optional byte lengths.

Forbidden content:

- raw keystrokes, input text, utterances, prompts, completions, replies, or
  response text;
- tool argument or result bodies, including values under `arguments`,
  `toolArgs`, or `rawArgs`;
- plaintext content in trajectory observability events.

Consent does not make a forbidden field valid. Even an opted-in trajectory
uses hashes and lengths only. A future richer format would require a separately
versioned contract and privacy review; it cannot be smuggled into
`trajectory.v1`.

## Worked valid trajectory

This is a complete, schema-valid metadata-only record. The executable golden
fixture is
[`perceive-reason-act-on-device.json`](../fixtures/trajectory/golden/perceive-reason-act-on-device.json).

```json
{
  "trajectoryFormatVersion": "trajectory.v1",
  "turnId": "turn-example-001",
  "subjectId": "learner-a",
  "deviceId": "edge-dev1",
  "capturedAt": "001700000000100:000002:edge-dev1",
  "locality": "on-device",
  "consentRecordId": "consent-traj-001",
  "stages": [
    { "stage": "perceive", "status": "ok", "chunkIndex": 0 },
    { "stage": "reason", "status": "ok", "chunkIndex": 0 },
    {
      "stage": "act",
      "status": "ok",
      "chunkIndex": 0,
      "opCode": "tool.invoke"
    }
  ],
  "toolCalls": [
    {
      "callId": "call-1",
      "toolName": "lookup_concept",
      "argsHash": "sha256:argsdeadbeef01",
      "argsByteLength": 48,
      "status": "ok",
      "resultHash": "sha256:resultdeadbeef01",
      "resultByteLength": 32
    }
  ],
  "outcomes": { "status": "completed", "terminalStage": "act" },
  "modelId": "slm-edge-v1",
  "promptHash": "sha256:prompthashexample01",
  "responseHash": "sha256:responsehashexample01",
  "promptByteLength": 256,
  "responseByteLength": 128
}
```

The hashes support equality checks without carrying plaintext; they do not
authorize retaining the corresponding plaintext in the trajectory.

## Worked rejection: raw keystrokes

Adding this property to the valid record is rejected with
`failureClass: "keystroke_forbidden"`:

```json
{
  "keystrokes": "raw learner typing"
}
```

The executable violation fixture is
[`forbidden-keystrokes.json`](../fixtures/trajectory/violations/forbidden-keystrokes.json).
Tool bodies such as `"arguments": {"query": "..."}` are rejected by the same
metadata-only gate; store `argsHash` and `argsByteLength` instead.

## Sovereignty and export procedure

1. Validate untrusted input with `parseTurnTrajectoryV1`. Do not persist or
   export a rejected value.
2. Keep storage bound to the record's `subjectId` and declared `locality`
   (`on-device` or `self-hosted`). A request for another subject is a defect.
3. Resolve `consentRecordId` from the consent ledger and call
   `assertTurnTrajectoryExportConsent`. Export only when the entry is active,
   opted in, and has the same `subjectId`.
4. Queue local persistence with `enqueueTurnTrajectoryWrite`; it returns before
   durable I/O and therefore does not hold the turn lock. Stage and tool-call
   arrays are bounded by the schema.
5. Make replay idempotent using the stable turn/subject identity. Never append
   a second logical trajectory merely because the same payload was retried.

Consent is required for export across the sovereign boundary. Merely carrying a
`consentRecordId` is not proof of consent: the referenced record must be
resolved and checked at export time, including after long-running work.

## Write queue and backpressure

`TrajectoryWriteAheadQueue` admits validated, consented records synchronously,
then writes a durable pending row before the idempotent final trajectory row.
The default queue capacity is 128 records and the configurable hard maximum is
4,096. At capacity, new capture is refused with `queue_full`, the dropped
counter increments, and a metadata-only `dropped` event is emitted. Existing
queued records are never evicted, and the turn path never waits for storage
space.

Storage operations time out after five seconds by default and retry at most
twice. Exhausted writes emit a typed rejection; a durable pending row, when one
was created, remains available for bounded startup recovery. Consent is checked
again after the pending write and before the final insert. Revocation deletes
the pending row and emits a consent rejection rather than persisting the
trajectory.

## Observability

The write-ahead queue emits `telemetry.trajectory.capture` with only
`subjectId`, `deviceId`, `turnId`, queue depth/retry counters, `outcome`, and an
optional bounded `failureClass`. Outcomes distinguish queued, recovered,
retrying, persisted, rejected, and dropped work. Validation, consent,
cross-subject, limit, and write failures remain distinct. Never attach prompts,
responses, utterances, tool bodies, hashes, or keystrokes to log events.
