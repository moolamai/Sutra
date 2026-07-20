# Canonical wire JSON Schemas

This directory is the **committed** JSON Schema export of every wire-boundary
type in `@moolam/sync-protocol`. Humans and CI both regenerate it with the
**same** command. If a PR changes a file here without a matching Zod change
(or the reverse), the upcoming schema-drift gate will fail with a exact diff.

| File | Wire type | Zod source (package barrel) |
|---|---|---|
| `FrictionSample.json` | `FrictionSample` | `frictionSampleSchema` |
| `FrictionAggregationRollup.json` | `FrictionAggregationRollup` | `frictionAggregationRollupSchema` |
| `ConceptMastery.json` | `ConceptMastery` | `conceptMasterySchema` |
| `CognitiveState.json` | `CognitiveState` | `cognitiveStateSchema` |
| `SyncRequest.json` | `SyncRequest` | `syncRequestSchema` |
| `SyncResponse.json` | `SyncResponse` | `syncResponseSchema` |
| `SyncAdvisory.json` | `SyncAdvisory` | `syncAdvisorySchema` |
| `AgentTurnRequest.json` | `AgentTurnRequest` | `agentTurnRequestSchema` |
| `AgentTurnResponse.json` | `AgentTurnResponse` | `agentTurnResponseSchema` |
| `HarnessFrame.json` | `HarnessFrame` (stream frame union) | `harnessFrameSchema` |
| `ToolCallEnvelope.json` | `ToolCallEnvelope` (single or array) | `toolCallEnvelopeSchema` |
| `ToolEnvelopeError.json` | Repair-loop error payload | `toolEnvelopeErrorSchema` |
| `MeterEvent.json` | Per-turn meter tick (`METER_TICK.tick`) | `meterEventSchema` |
| `DegradationRegistry.json` | Named degradation modes + bindings | `degradationRegistrySchema` |
| `FreshnessMarker.json` | Stale-read freshness marker | `freshnessMarkerSchema` |
| `DegradationStubVectorCatalog.json` | Stubbed-down dependency test vectors | `degradationStubVectorCatalogSchema` |
| `TurnTrajectoryV1.json` | Metadata-grade turn trajectory capture | `turnTrajectoryV1Schema` |
| `EventTurnStageStart.json` | EventBus `turn.stage.start` | `@moolam/observability` `eventTurnStageStartSchema` |
| `EventTurnStageEnd.json` | EventBus `turn.stage.end` | `eventTurnStageEndSchema` |
| `EventTurnFrictionSummary.json` | EventBus `turn.friction.summary` | `eventTurnFrictionSummarySchema` |
| `EventSyncOutcome.json` | EventBus `sync.outcome` | `eventSyncOutcomeSchema` |
| `EventSyncAdvisory.json` | EventBus `sync.advisory` | `eventSyncAdvisorySchema` |
| `EventToolInvoked.json` | EventBus `tool.invoked` | `eventToolInvokedSchema` |
| `EventToolResult.json` | EventBus `tool.result` | `eventToolResultSchema` |
| `EventHarnessMeter.json` | EventBus `harness.meter` | `eventHarnessMeterSchema` |
| `EventRuntimeSubscriberError.json` | EventBus `runtime.subscriber-error` | `eventRuntimeSubscriberErrorSchema` |

Every file carries `"x-protocol-version": "<PROTOCOL_VERSION>"` (today
`"1.0.0"`). Event catalog files also carry `"x-event-catalog-version"` and
`"x-event-type"`. Bumping the wire or catalog version makes that metadata
change show up in review.

## Regenerate (one command)

From the monorepo root:

```bash
pnpm --filter @moolam/sync-protocol schemas:export
```

That builds the package, then runs `scripts/export-schemas.mjs`, which imports
schemas **only** from the package barrel (`dist/index.js`) — never from a
private module path. Override the output directory with `SCHEMA_OUT_DIR` if you
need a disposable copy for experiments; leave the default (`schemas/`) for the
committed surface.

Two consecutive exports into separate directories must be **byte-identical**.
If they are not, the exporter is broken — do not commit the flap.

## Normalization rules (what you should expect in the diff)

The exporter does **not** check in raw library output. Each document is
post-processed so Zod ↔ Pydantic drift CI compares meaning, not accident:

1. **Canonical key order** — every object’s keys are sorted lexicographically;
   unordered string arrays (`required`, `enum`) and object arrays (`anyOf`, …)
   are sorted for stable bytes.
2. **`$ref` / `$defs` names** — library auto-names like `__schema0` are rewritten
   to content digests (`def_<sha12>`) so renaming quirks cannot flap the gate.
3. **Wire input shape** — conversion uses Zod’s `io: "input"` so branded values
   (HLC `transform`) export as the wire string (with the HLC regex), not the
   output brand.
4. **Protocol metadata** — each file gets `title: "<TypeName>"` and
   `x-protocol-version`.

### Worked example — `SyncAdvisory.json` (excerpt)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "properties": {
    "code": {
      "enum": [
        "CLOCK_SKEW_CLAMPED",
        "DUPLICATE_SAMPLE_DROPPED",
        "STATE_VECTOR_REGRESSION",
        "UNKNOWN_CONCEPT_QUARANTINED"
      ],
      "type": "string"
    },
    "detail": { "type": "string" }
  },
  "required": ["code", "detail"],
  "title": "SyncAdvisory",
  "type": "object",
  "x-protocol-version": "1.0.0"
}
```

Note the alphabetized `enum` / `required` lists and the protocol metadata —
these are intentional, not noise.

### Worked example — subject isolation on the wire

`CognitiveState.json` and `AgentTurnRequest.json` both list `"subjectId"` under
`required`. That is the schema-level subject-isolation rule: payloads without a
subject are rejected at the boundary. Cross-subject access is a defect, not a
feature gap.

## Reviewer checklist

When a PR touches this directory or `src/contract.ts`:

1. Confirm `schemas:export` was re-run and **only intentional** shape changes appear.
2. Confirm every wire type listed above still has a file.
3. Confirm `x-protocol-version` matches `PROTOCOL_VERSION` in `src/contract.ts`.
4. Reject hand-edited JSON that was not produced by the exporter.

Hand-edits will be overwritten on the next export and will desync the CI gate.

## Out of scope here

Pydantic’s twin export and the `schema-drift` CI job live in sibling modules of
this epic. This directory is the **Zod** side of the contract only.
