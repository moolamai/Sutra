/**
 * Live offline-edge turn: EdgeAgent + LlamaCppSlmRuntime + local Ollama.
 *
 * CI certification keeps {@link proveLlamaCppOfflineDesktopTurn} on the
 * in-process stand-in (zero egress). This path is for local demos: loopback
 * Ollama only — no third-party cloud egress.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  createLoopbackPermitEgressMockAgent,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import {
  EdgeAgent,
  createLocalVectorMemoryDriver,
  type AgentReply,
} from "@moolam/edge-agent";
import type { FrictionSample, HLCTimestamp } from "@moolam/sync-protocol";
import { LlamaCppSlmRuntime } from "./llamacpp_runtime.js";
import {
  createOllamaLlamaCppBackend,
  probeOllamaReachable,
  resolveOllamaConfigFromEnv,
  type OllamaConfigFromEnv,
} from "./ollama_backend.js";
import { OFFLINE_EDGE_GOLDEN_RELPATH } from "./offline_turn_proof.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DESKTOP_FIXTURE = path.join(
  PACKAGE_ROOT,
  "certification/fixtures/desktop-minimal.gguf",
);

const IN_PROCESS_REPLY_PATTERN = /^ll:\d+:\d+$/;
/** Cold Ollama on consumer hardware can exceed the default 5s egress harness budget. */
const OFFLINE_EDGE_LIVE_EGRESS_DEADLINE_MS = 120_000;
/** First local inference after pull can exceed the 30s model-adapter default. */
const OFFLINE_EDGE_LIVE_MODEL_DEADLINE_MS = 90_000;

export type OfflineEdgeLiveTurnOptions = {
  utterance?: string;
  subjectId?: string;
  deviceId?: string;
  ollama?: OllamaConfigFromEnv;
  weightsPath?: string;
  onTelemetry?: (event: OfflineEdgeLiveTelemetry) => void;
};

export type OfflineEdgeLiveTelemetry = {
  event: "bindings_slm.offline_edge_live";
  outcome: "start" | "pass" | "fail" | "ollama_unreachable";
  subjectId: string;
  deviceId: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  thirdPartyEgressCount?: number;
  loopbackEgressCount?: number;
  detail?: string;
};

export type OfflineEdgeLiveTurnResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  reply: AgentReply | null;
  servedLocally: boolean;
  syncStatus: string | null;
  ollamaModel: string;
  ollamaBaseUrl: string;
  thirdPartyEgressCount: number;
  loopbackEgressCount: number;
  localityOk: boolean;
  failures: string[];
};

type GoldenTurn = {
  subjectId: string;
  deviceId: string;
  utterance: string;
  profile: {
    ageBand: "child" | "adolescent" | "adult";
    track: string;
    language: string;
  };
  friction: {
    conceptId: string;
    hesitationMs: number;
    inputVelocity: number;
    revisionCount: number;
    assistanceRequested: boolean;
    outcome: string;
    capturedAt: string;
  };
  expect: { conceptId: string; syncStatus: string };
};

function loadGolden(): GoldenTurn {
  const goldenPath = path.resolve(PACKAGE_ROOT, OFFLINE_EDGE_GOLDEN_RELPATH);
  if (!existsSync(goldenPath)) {
    throw new Error(`offline-edge golden missing at ${goldenPath}`);
  }
  return JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenTurn;
}

function loopbackHosts(baseUrl: string): string[] {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return [host, "127.0.0.1", "localhost", "::1"];
}

function emit(
  options: OfflineEdgeLiveTurnOptions,
  partial: Omit<OfflineEdgeLiveTelemetry, "event">,
): void {
  options.onTelemetry?.({
    event: "bindings_slm.offline_edge_live",
    ...partial,
  });
}

/**
 * Run one offline EdgeAgent turn backed by a local Ollama model.
 * Fails fast when Ollama is down or the model tag is missing.
 */
export async function runOfflineEdgeLiveTurn(
  options: OfflineEdgeLiveTurnOptions = {},
): Promise<OfflineEdgeLiveTurnResult> {
  const golden = loadGolden();
  const ollama = options.ollama ?? resolveOllamaConfigFromEnv();
  const subjectId = (options.subjectId ?? golden.subjectId).trim();
  const deviceId = (options.deviceId ?? golden.deviceId).trim();
  const utterance = options.utterance ?? golden.utterance;
  const weightsPath = options.weightsPath ?? DESKTOP_FIXTURE;
  const failures: string[] = [];

  if (!existsSync(weightsPath)) {
    failures.push(`GGUF metadata fixture missing: ${weightsPath}`);
  }

  const reachability = await probeOllamaReachable(ollama);
  if (!reachability.ok) {
    emit(options, {
      outcome: "ollama_unreachable",
      subjectId,
      deviceId,
      ollamaBaseUrl: reachability.baseUrl,
      ollamaModel: reachability.model,
      detail: reachability.detail,
    });
    return {
      ok: false,
      subjectId,
      deviceId,
      reply: null,
      servedLocally: false,
      syncStatus: null,
      ollamaModel: ollama.model,
      ollamaBaseUrl: ollama.baseUrl,
      thirdPartyEgressCount: 0,
      loopbackEgressCount: 0,
      localityOk: false,
      failures: [reachability.detail],
    };
  }

  emit(options, {
    outcome: "start",
    subjectId,
    deviceId,
    ollamaBaseUrl: ollama.baseUrl,
    ollamaModel: ollama.model,
  });

  const friction: FrictionSample = {
    conceptId: golden.friction.conceptId,
    hesitationMs: golden.friction.hesitationMs,
    inputVelocity: golden.friction.inputVelocity,
    revisionCount: golden.friction.revisionCount,
    assistanceRequested: golden.friction.assistanceRequested,
    outcome: (golden.friction.outcome === "correct" ||
    golden.friction.outcome === "partial" ||
    golden.friction.outcome === "incorrect"
      ? golden.friction.outcome
      : "ungraded") as FrictionSample["outcome"],
    capturedAt: golden.friction.capturedAt as HLCTimestamp,
  };

  let reply: AgentReply | null = null;
  let servedLocally = false;
  let syncStatus: string | null = null;
  let thirdPartyEgressCount = 0;
  let loopbackEgressCount = 0;
  let localityOk = false;

  if (failures.length > 0) {
    return {
      ok: false,
      subjectId,
      deviceId,
      reply: null,
      servedLocally: false,
      syncStatus: null,
      ollamaModel: ollama.model,
      ollamaBaseUrl: ollama.baseUrl,
      thirdPartyEgressCount: 0,
      loopbackEgressCount: 0,
      localityOk: false,
      failures,
    };
  }

  const ollamaUrl = new URL(ollama.baseUrl);
  const ollamaPort = ollamaUrl.port
    ? Number(ollamaUrl.port)
    : ollamaUrl.protocol === "https:"
      ? 443
      : 80;
  const selfHostedHosts = loopbackHosts(ollama.baseUrl);
  const egressMock = createLoopbackPermitEgressMockAgent(selfHostedHosts, {
    ports: [ollamaPort],
  });

  try {
    const { turn, value } = await withEgressRecordingTurn(
      {
        subjectId,
        deviceId,
        caller: { principalId: "offline-edge-live", subjectScope: "*" },
        selfHostedHosts,
        downstream: egressMock,
        deadlineMs: OFFLINE_EDGE_LIVE_EGRESS_DEADLINE_MS,
      },
      async (api) =>
        api.withPayloadClass("model-prompt", async () => {
          const runtime = new LlamaCppSlmRuntime({
            weightsPath,
            subjectId,
            deviceId,
            backend: createOllamaLlamaCppBackend({
              baseUrl: ollama.baseUrl,
              model: ollama.model,
            }),
          });
          const agent = new EdgeAgent({
            subjectId,
            deviceId,
            runtime,
            storage: createLocalVectorMemoryDriver(),
            profile: golden.profile,
            attachEventBusSpans: false,
            modelDefaultDeadlineMs: OFFLINE_EDGE_LIVE_MODEL_DEADLINE_MS,
          });
          await agent.initialize();
          const first = await agent.agentTurn(utterance, friction);
          const sync = await agent.syncNow();
          return { first, sync };
        }),
    );

    thirdPartyEgressCount = turn.attempts.filter(
      (a) => a.destinationClass === "third-party",
    ).length;
    loopbackEgressCount = turn.attempts.filter(
      (a) => a.destinationClass === "self-hosted",
    ).length;
    const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
    localityOk = asserted.ok && thirdPartyEgressCount === 0;

    reply = value.first;
    servedLocally = value.first.servedLocally === true;
    syncStatus =
      value.sync && typeof value.sync === "object" && "status" in value.sync
        ? String((value.sync as { status: string }).status)
        : null;

    if (!servedLocally) failures.push("reply.servedLocally !== true");
    const text = reply?.text?.trim() ?? "";
    if (text.length < 8) failures.push("reply text too short for live model");
    if (IN_PROCESS_REPLY_PATTERN.test(text)) {
      failures.push(
        "reply matches CI in-process stand-in; Ollama backend did not run",
      );
    }
    if (reply?.conceptId !== golden.expect.conceptId) {
      failures.push(
        `conceptId mismatch: got ${reply?.conceptId} want ${golden.expect.conceptId}`,
      );
    }
    if (syncStatus !== golden.expect.syncStatus) {
      failures.push(
        `sync status ${syncStatus} !== ${golden.expect.syncStatus}`,
      );
    }
    if (thirdPartyEgressCount > 0) {
      failures.push(
        `third-party egress during live turn: ${thirdPartyEgressCount}`,
      );
    }
    if (!asserted.ok) {
      failures.push(
        `locality assertion failed: ${asserted.violations.map((v) => v.code).join(", ")}`,
      );
    }
  } catch (err) {
    failures.push(
      `live offline turn threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ok = failures.length === 0;
  emit(options, {
    outcome: ok ? "pass" : "fail",
    subjectId,
    deviceId,
    ollamaBaseUrl: ollama.baseUrl,
    ollamaModel: ollama.model,
    thirdPartyEgressCount,
    loopbackEgressCount,
    ...(failures[0] ? { detail: failures[0] } : {}),
  });

  return {
    ok,
    subjectId,
    deviceId,
    reply,
    servedLocally,
    syncStatus,
    ollamaModel: ollama.model,
    ollamaBaseUrl: ollama.baseUrl,
    thirdPartyEgressCount,
    loopbackEgressCount,
    localityOk,
    failures,
  };
}
