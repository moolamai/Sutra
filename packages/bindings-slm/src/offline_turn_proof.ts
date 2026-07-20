/**
 * Full offline CognitiveCore turn proof on the desktop llama.cpp profile.
 *
 * Path mirrors examples/offline-edge: EdgeAgent + LlamaCppSlmRuntime, no sync
 * transport, network denied via the locality egress recorder.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import {
  EdgeAgent,
  createLocalVectorMemoryDriver,
  type AgentReply,
} from "@moolam/edge-agent";
import { InProcessEventBus } from "@moolam/runtime";
import { TURN_COMPLETED, parseCatalogEvent } from "@moolam/observability";
import type { FrictionSample, HLCTimestamp } from "@moolam/sync-protocol";
import { LLAMA_CPP_PINNED_REVISION } from "./gguf_metadata.js";
import { LlamaCppSlmRuntime } from "./llamacpp_runtime.js";
import type { CertProfile } from "./certify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DESKTOP_PROFILE_PATH = path.join(
  PACKAGE_ROOT,
  "certification/desktop.profile.json",
);

/** Repo-relative from packages/bindings-slm (src or dist). */
export const OFFLINE_EDGE_GOLDEN_RELPATH =
  "../../examples/offline-edge/golden-turn.json";

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function loadDesktopProfile(): CertProfile {
  return JSON.parse(readFileSync(DESKTOP_PROFILE_PATH, "utf8")) as CertProfile;
}

export type OfflineTurnProofOptions = {
  /** Override profile (defaults to desktop.profile.json). */
  profile?: CertProfile;
  /** Utterance override (defaults to offline-edge golden). */
  utterance?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: OfflineTurnProofTelemetry) => void;
};

export type OfflineTurnProofTelemetry = {
  event: "bindings_slm.offline_turn_proof";
  outcome:
    | "start"
    | "pass"
    | "fail"
    | "egress_fail"
    | "restart_ok"
    | "subject_isolation_ok";
  subjectId: string;
  deviceId: string;
  modelArtifactSha256?: string;
  llamaCppPinnedRevision?: string;
  detail?: string;
};

export type OfflineTurnProofResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  modelArtifactSha256: string;
  measuredArtifactSha256: string;
  llamaCppPinnedRevision: string;
  reply: AgentReply | null;
  servedLocally: boolean;
  frictionFolded: boolean;
  syncStatus: string | null;
  turnCompletedEmitted: boolean;
  egressAttemptCount: number;
  localityOk: boolean;
  /** Runtime unload → load → second turn succeeded. */
  restartSurvived: boolean;
  /** Concurrent peer subject did not leak mastery / telemetry. */
  subjectIsolationOk: boolean;
  failures: string[];
};

function loadGolden(): {
  utterance: string;
  friction: {
    conceptId: string;
    hesitationMs: number;
    inputVelocity: number;
    revisionCount: number;
    assistanceRequested: boolean;
    outcome: string;
    capturedAt: string;
  };
  profile: {
    ageBand: "child" | "adolescent" | "adult";
    track: string;
    language: string;
  };
  expect: { conceptId: string; syncStatus: string };
} {
  const goldenPath = path.resolve(PACKAGE_ROOT, OFFLINE_EDGE_GOLDEN_RELPATH);
  if (!existsSync(goldenPath)) {
    throw new Error(`offline-edge golden missing at ${goldenPath}`);
  }
  return JSON.parse(readFileSync(goldenPath, "utf8"));
}

function emit(
  options: OfflineTurnProofOptions,
  partial: Omit<OfflineTurnProofTelemetry, "event">,
): void {
  options.onTelemetry?.({
    event: "bindings_slm.offline_turn_proof",
    ...partial,
  });
}

/**
 * Prove one complete offline EdgeAgent / CognitiveCore turn with
 * {@link LlamaCppSlmRuntime} under network deny (desktop profile pins).
 */
export async function proveLlamaCppOfflineDesktopTurn(
  options: OfflineTurnProofOptions = {},
): Promise<OfflineTurnProofResult> {
  const profile = options.profile ?? loadDesktopProfile();
  const golden = loadGolden();
  const subjectId = (options.subjectId ?? profile.subjectId).trim();
  const deviceId = (options.deviceId ?? profile.deviceId).trim();
  const utterance = options.utterance ?? golden.utterance;
  const failures: string[] = [];

  const fixturePath = path.join(
    PACKAGE_ROOT,
    profile.modelArtifact.fixtureRelpath,
  );
  if (!existsSync(fixturePath)) {
    failures.push(`GGUF fixture missing: ${fixturePath}`);
  }
  const measuredSha =
    failures.length === 0 ? sha256File(fixturePath) : "";
  if (
    measuredSha &&
    measuredSha !== profile.modelArtifact.artifactSha256.toLowerCase()
  ) {
    failures.push(
      `artifact hash mismatch: profile=${profile.modelArtifact.artifactSha256} measured=${measuredSha}`,
    );
  }
  if (profile.modelArtifact.llamaCppPinnedRevision !== LLAMA_CPP_PINNED_REVISION) {
    failures.push(
      `llama.cpp pin mismatch: profile=${profile.modelArtifact.llamaCppPinnedRevision} package=${LLAMA_CPP_PINNED_REVISION}`,
    );
  }

  emit(options, {
    outcome: "start",
    subjectId,
    deviceId,
    modelArtifactSha256: profile.modelArtifact.artifactSha256,
    llamaCppPinnedRevision: profile.modelArtifact.llamaCppPinnedRevision,
  });

  let reply: AgentReply | null = null;
  let servedLocally = false;
  let frictionFolded = false;
  let syncStatus: string | null = null;
  let turnCompletedEmitted = false;
  let egressAttemptCount = 0;
  let localityOk = false;
  let restartSurvived = false;
  let subjectIsolationOk = false;

  if (failures.length > 0) {
    emit(options, {
      outcome: "fail",
      subjectId,
      deviceId,
      ...(failures[0] ? { detail: failures[0] } : {}),
    });
    return {
      ok: false,
      subjectId,
      deviceId,
      modelArtifactSha256: profile.modelArtifact.artifactSha256,
      measuredArtifactSha256: measuredSha,
      llamaCppPinnedRevision: profile.modelArtifact.llamaCppPinnedRevision,
      reply: null,
      servedLocally: false,
      frictionFolded: false,
      syncStatus: null,
      turnCompletedEmitted: false,
      egressAttemptCount: 0,
      localityOk: false,
      restartSurvived: false,
      subjectIsolationOk: false,
      failures,
    };
  }

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

  try {
    const { turn, value } = await withEgressRecordingTurn(
      {
        subjectId,
        deviceId,
        caller: { principalId: "offline-turn-proof", subjectScope: "*" },
        selfHostedHosts: ["school.local"],
      },
      async (api) => {
        const mock = api.mockAgent();
        mock
          ?.get("https://vendor.example")
          .intercept({ path: "/v1/infer", method: "POST" })
          .reply(200, { ok: true })
          .times(5);

        return api.withPayloadClass("model-prompt", async () => {
          const bus = new InProcessEventBus();
          const turnEvents: unknown[] = [];
          bus.subscribe(TURN_COMPLETED, (e) => turnEvents.push(e));

          const runtime = new LlamaCppSlmRuntime({
            weightsPath: fixturePath,
            subjectId,
            deviceId,
          });
          const storage = createLocalVectorMemoryDriver();
          const agent = new EdgeAgent({
            subjectId,
            deviceId,
            runtime,
            storage,
            profile: golden.profile,
            eventBus: bus,
            attachEventBusSpans: false,
          });

          await agent.initialize();
          const first = await agent.agentTurn(utterance, friction);
          const sync = await agent.syncNow();

          const mastery = agent.cognitiveState.mastery[friction.conceptId];
          const foldOk =
            !!mastery && mastery.lastExercisedAt === friction.capturedAt;

          // Restart survival: unload native weights, load again, second turn.
          await runtime.unload();
          await runtime.load();
          const second = await agent.agentTurn(
            `${utterance} (restart)`,
            {
              ...friction,
              capturedAt: `${friction.capturedAt}:r2` as HLCTimestamp,
            },
          );
          const restartOk =
            second.servedLocally === true &&
            typeof second.text === "string" &&
            second.text.length > 0;

          // Catalog-valid turn.completed (metadata only).
          let catalogOk = false;
          for (const ev of turnEvents) {
            const parsed = parseCatalogEvent(ev);
            if (parsed.ok && parsed.event?.type === TURN_COMPLETED) {
              catalogOk = true;
              const payload = parsed.event.payload as {
                subjectId?: string;
                servedLocally?: boolean;
              };
              if (payload.subjectId !== subjectId) {
                failures.push("turn.completed subjectId mismatch");
              }
              if (payload.servedLocally !== true) {
                failures.push("turn.completed servedLocally !== true");
              }
            }
          }

          return {
            first,
            sync,
            foldOk,
            restartOk,
            catalogOk,
            turnEventCount: turnEvents.length,
          };
        });
      },
    );

    egressAttemptCount = turn.attempts.length;
    const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
    localityOk = asserted.ok === true && turn.noEgress === true;
    if (!localityOk) {
      failures.push(
        `egress during offline turn: attempts=${egressAttemptCount} (network must stay denied)`,
      );
      emit(options, {
        outcome: "egress_fail",
        subjectId,
        deviceId,
        detail: `attempts=${egressAttemptCount}`,
      });
    }

    reply = value.first;
    servedLocally = value.first.servedLocally === true;
    frictionFolded = value.foldOk === true;
    syncStatus =
      value.sync && typeof value.sync === "object" && "status" in value.sync
        ? String((value.sync as { status: string }).status)
        : null;
    turnCompletedEmitted = value.catalogOk === true;
    restartSurvived = value.restartOk === true;

    if (!servedLocally) failures.push("reply.servedLocally !== true");
    if (!reply?.text?.trim()) failures.push("empty CognitiveCore reply text");
    if (reply?.conceptId !== golden.expect.conceptId) {
      failures.push(
        `conceptId mismatch: got ${reply?.conceptId} want ${golden.expect.conceptId}`,
      );
    }
    if (!frictionFolded) failures.push("friction fold missing after turn");
    if (syncStatus !== golden.expect.syncStatus) {
      failures.push(
        `sync status ${syncStatus} !== ${golden.expect.syncStatus}`,
      );
    }
    if (!turnCompletedEmitted) {
      failures.push("turn.completed catalog event not emitted");
    }
    if (!restartSurvived) {
      failures.push("runtime unload/load restart turn failed");
    } else {
      emit(options, { outcome: "restart_ok", subjectId, deviceId });
    }
  } catch (err) {
    failures.push(
      `offline turn threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Subject isolation: peer subject on separate agent must not see our mastery.
  try {
    const peerSubject = `${subjectId}::peer`;
    const peerRuntime = new LlamaCppSlmRuntime({
      weightsPath: fixturePath,
      subjectId: peerSubject,
      deviceId: `${deviceId}-peer`,
    });
    const peer = new EdgeAgent({
      subjectId: peerSubject,
      deviceId: `${deviceId}-peer`,
      runtime: peerRuntime,
      storage: createLocalVectorMemoryDriver(),
      profile: golden.profile,
      attachEventBusSpans: false,
    });
    await peer.initialize();
    await peer.agentTurn("peer isolation probe", {
      ...friction,
      conceptId: "peer.only.concept",
      capturedAt: `${friction.capturedAt}:peer` as HLCTimestamp,
    });
    const peerHasOurs = peer.cognitiveState.mastery[friction.conceptId];
    if (peerHasOurs) {
      failures.push("cross-subject mastery leak into peer agent");
      subjectIsolationOk = false;
    } else {
      subjectIsolationOk = true;
      emit(options, {
        outcome: "subject_isolation_ok",
        subjectId: peerSubject,
        deviceId: `${deviceId}-peer`,
      });
    }
    await peerRuntime.unload().catch(() => undefined);
  } catch (err) {
    failures.push(
      `subject isolation probe threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    subjectIsolationOk = false;
  }

  const ok = failures.length === 0;
  emit(options, {
    outcome: ok ? "pass" : "fail",
    subjectId,
    deviceId,
    modelArtifactSha256: profile.modelArtifact.artifactSha256,
    llamaCppPinnedRevision: profile.modelArtifact.llamaCppPinnedRevision,
    ...(ok ? {} : { detail: failures[0] }),
  });

  return {
    ok,
    subjectId,
    deviceId,
    modelArtifactSha256: profile.modelArtifact.artifactSha256,
    measuredArtifactSha256: measuredSha,
    llamaCppPinnedRevision: profile.modelArtifact.llamaCppPinnedRevision,
    reply,
    servedLocally,
    frictionFolded,
    syncStatus,
    turnCompletedEmitted,
    egressAttemptCount,
    localityOk,
    restartSurvived,
    subjectIsolationOk,
    failures,
  };
}
