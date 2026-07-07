/**
 * @moolam/sdk - the one import an application needs.
 *
 * ```ts
 * import { CognitiveCore } from "@moolam/sdk";
 * ```
 *
 * The SDK re-exports the stable public APIs of the platform packages.
 * Applications should import from here; internal packages remain
 * importable individually for advanced integrations, but their layout
 * may shift between minor versions while the SDK surface stays stable.
 *
 * Layering (each layer depends only on layers above it):
 *   contracts       - pure interfaces, zero dependencies
 *   sync-protocol   - wire contract + CRDT reconciliation
 *   cognitive-core  - the agent loop composed from contracts
 *   runtime         - lifecycle host, scheduler, event bus
 *   telemetry       - friction sensing
 *   edge-agent      - offline-first on-device host
 */

// Pure contracts: memory, model, reasoning, planning, knowledge, tool,
// vision, speech, runtime.
export * from "@moolam/contracts";

// The cognitive core: CognitiveCore, CognitiveBindings, AgentProfile.
export * from "@moolam/cognitive-core";

// Reference runtime: RuntimeHost, InProcessScheduler, InProcessEventBus.
export * from "@moolam/runtime";

// Friction telemetry: CognitiveTelemetryCollector, InteractionEvent.
export * from "@moolam/telemetry";

// Wire contract + CRDT engine: CognitiveState, CrdtHarnessResolver,
// HlcClock, SyncEngine, schemas.
export * from "@moolam/sync-protocol";

// Edge host: EdgeAgent, LocalVectorDb, SlmRuntime adapters.
export * from "@moolam/edge-agent";
