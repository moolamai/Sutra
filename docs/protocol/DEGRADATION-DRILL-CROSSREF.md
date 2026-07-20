# Degradation drill cross-reference

Maps each dependency-failure mode to the **degradation registry** behavior it
must observe, and to the **chaos / harness drill** that proves it.

Normative registry: [`DEGRADATION-REGISTRY.md`](./DEGRADATION-REGISTRY.md) ·
Fixture: [`packages/sync-protocol/fixtures/degradation-registry/default-registry.json`](../../packages/sync-protocol/fixtures/degradation-registry/default-registry.json)

Machine-checkable rows (verbatim signal / freshness / failureClass strings):
[`benchmarks/chaos/degradation_registry_crossref.json`](../../benchmarks/chaos/degradation_registry_crossref.json)

Gate: `pnpm --filter @moolam/benchmarks exec node --test gates/degradation_registry_crossref.test.mjs`
· Runner mode: `SUTRA_DEGR_DRILL=crossref pnpm --filter @moolam/benchmarks degradation-drills`

---

## 1. Invariants (every row)

| Invariant | Registry rule |
|---|---|
| Never fabricate | `allowsFabrication: false` on every mode |
| No silent write retry | `allowsSilentWriteRetry: false` |
| Subject isolation | Signals / markers scoped by `subjectId` (metadata only) |
| Observability | Distinct `signalCode` or `failureClass` — never silent catch-and-continue |

---

## 2. Failure mode → registry → proving drill

### 2.1 Default registry bindings (harness adapters)

| Failure mode | Surface × op | Mode | Signal (verbatim) | Proving drill |
|---|---|---|---|---|
| Sync transport down (read) | `sync` × `read` | `STALE_READ` | `DEGRADE_STALE_READ` | [`packages/runtime-harness/test/degradation_drills/sync_down.test.mjs`](../../packages/runtime-harness/test/degradation_drills/sync_down.test.mjs) |
| Sync transport down (write) | `sync` × `write` | `HARD_STOP_WRITE` | `DEGRADE_HARD_STOP_WRITE` | same |
| Storage down (read) | `storage` × `read` | `STALE_READ` | `DEGRADE_STALE_READ` | [`registry_alignment_gate.mjs`](../../packages/runtime-harness/test/degradation_drills/registry_alignment_gate.mjs) |
| Storage down (write) | `storage` × `write` | `HARD_STOP_WRITE` | `DEGRADE_HARD_STOP_WRITE` | same |
| Model provider unavailable (read/queue) | `model` × `read` | `QUEUE_AND_WARN` | `DEGRADE_QUEUE_AND_WARN` | [`model_down.test.mjs`](../../packages/runtime-harness/test/degradation_drills/model_down.test.mjs) |
| Model provider unavailable (write) | `model` × `write` | `HARD_STOP_WRITE` | `DEGRADE_HARD_STOP_WRITE` | same |

CI alignment (row signals must match the registry document byte-for-byte on
`signalCode`): `pnpm --filter @moolam/runtime-harness run test:degradation-drills`
and `registry_alignment_gate.mjs --check`.

### 2.2 P4 chaos degradation drills (deployed paths)

| Failure mode | Observed behavior | Registry invariant proved | Proving drill |
|---|---|---|---|
| Cloud LLM generate timeout | ATR-05: reply = guidance **directive** (`GUIDE concept=…`); `degraded: true`; `freshnessMarker.source: last-known-good`; HTTP **200** (not 5xx); never fabricate prose | `STALE_READ` / freshness (`DEGRADE_STALE_READ` semantics on the last-known-good directive) | `SUTRA_DEGR_DRILL=cloud_llm_down` → [`benchmarks/chaos/degradation_drills.mjs`](../../benchmarks/chaos/degradation_drills.mjs) · task family [degradation-drills](../stages/tracks/track-a-sovereign-protocol/p4-performance-gates/chaos-resilience/degradation-drills/INDEX.md) |
| Edge SLM missing weights | `SlmRuntimeInitError` `failureClass: missing_weights`; obligation `EDGE.SLM_LOAD`; telemetry `edge_agent.slm_runtime` `outcome=init_error`; **no** crash loop; no lifecycle ready | Typed init (not silent retry); never fabricate | `SUTRA_DEGR_DRILL=edge_slm_failure` mode `missing` · `LocalWeightSlmRuntime` in [`packages/edge-agent/src/slm_runtime.ts`](../../packages/edge-agent/src/slm_runtime.ts) |
| Edge SLM corrupt weights | `failureClass: corrupt_weights`; one attempt per `load()` | Same | mode `corrupt` |

Cloud agent-turn path: [`packages/cloud-orchestrator/src/sutra_orchestrator/agent_runtime.py`](../../packages/cloud-orchestrator/src/sutra_orchestrator/agent_runtime.py)
(timeout → directive + freshness marker).

---

## 3. Worked examples (real drill output shapes)

### 3.1 Cloud LLM timeout (ATR-05)

Fault: `DeterministicFakeProvider(force_timeout=True)` on `/v1/agent/turn`.

```json
{
  "drill": "cloud_llm_down",
  "ok": true,
  "degraded": true,
  "replyStartsWithGuide": true,
  "freshnessSource": "last-known-good",
  "httpStatus": 200,
  "fabricated": false
}
```

`freshnessSource` is taken **verbatim** from the registry freshness enum
(`last-known-good` \| `local-cache`) in
[`FreshnessMarker.json`](../../packages/sync-protocol/schemas/FreshnessMarker.json).

### 3.2 Edge SLM missing weights

Fault: `LocalWeightSlmRuntime` pointed at a non-existent weights path.

```json
{
  "drill": "edge_slm_failure",
  "ok": true,
  "failureClass": "missing_weights",
  "loadAttempts": 1,
  "crashLoop": false,
  "telemetryEmitted": true,
  "fabricated": false
}
```

### 3.3 Model write hard-stop (harness)

Fault: model provider killed during write via `invokeModelDependency`.

Expected signal code **verbatim**: `DEGRADE_HARD_STOP_WRITE`
(`allowsSilentWriteRetry` remains false; `rolledBack: true`).

---

## 4. Sovereignty

- Every drill row carries `subjectId` / `deviceId` on telemetry — never utterance /
  prompt / learner content.
- Cross-subject isolation is negative-tested in both P4 drills and harness suites.
- Empty `subjectId` is rejected at registry lookup (see `DEGRADATION-REGISTRY.md` §4).

---

## 5. Related

- Registry contract: [`DEGRADATION-REGISTRY.md`](./DEGRADATION-REGISTRY.md)
- Interfaces: [`docs/sdk/INTERFACES.md`](../sdk/INTERFACES.md)
- Chaos submodule: [degradation-drills DESIGN](../stages/tracks/track-a-sovereign-protocol/p4-performance-gates/chaos-resilience/degradation-drills/DESIGN.md)
- Benchmarks entry: [`benchmarks/README.md`](../../benchmarks/README.md)
