/**
 * Offline pack retrieve proof (CK-09.2) under the B1 locality egress recorder.
 *
 * Network is fully denied at the undici seam; PackKnowledgeConnector must still
 * return cited passages from the bundled pack with zero egress attempts.
 */

import path from "node:path";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  KNOWLEDGE_CHECK_CLOCK_MS,
  KNOWLEDGE_OBLIGATION_IDS,
  assertLocality,
  createOfflineStalenessObligationRegistry,
  runConformance,
  withEgressRecordingTurn,
  type KnowledgeConformanceHarness,
} from "@moolam/contract-conformance";
import { KNOWLEDGE_PACKAGE_ROOT, type PackFormatTelemetry } from "./pack_format.js";
import {
  PackKnowledgeConnector,
  type PackLoaderTelemetry,
} from "./pack_loader.js";

/** Default fixture pack used by the offline prove (bundled-offline + citations). */
export const DEFAULT_OFFLINE_PACK_RELPATH = path.join(
  "fixtures",
  "pack-v1",
  "valid",
);

export type OfflinePackRetrieveTelemetry = {
  event: "bindings_knowledge.offline_pack_retrieve";
  outcome:
    | "start"
    | "pass"
    | "fail"
    | "egress_fail"
    | "ck09_fail"
    | "subject_isolation_ok";
  subjectId: string;
  deviceId: string;
  packId?: string;
  detail?: string;
  egressAttemptCount?: number;
};

type PackProofTelemetry =
  | OfflinePackRetrieveTelemetry
  | PackLoaderTelemetry
  | PackFormatTelemetry;

export type ProveOfflinePackRetrieveOptions = {
  subjectId?: string;
  deviceId?: string;
  /** Absolute or package-relative pack root (default: fixtures/pack-v1/valid). */
  packRoot?: string;
  nowMs?: number;
  onTelemetry?: (e: PackProofTelemetry) => void;
};

export type ProveOfflinePackRetrieveResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  packId: string;
  locality: string;
  asOf: string;
  passageCount: number;
  egressAttemptCount: number;
  localityOk: boolean;
  ck092Ok: boolean;
  citationsResolvable: boolean;
  subjectIsolationOk: boolean;
  failures: string[];
};

function emitProof(
  onTelemetry: ((e: PackProofTelemetry) => void) | undefined,
  partial: Omit<OfflinePackRetrieveTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.offline_pack_retrieve",
    ...partial,
  });
}

function resolvePackRoot(packRoot: string | undefined): string {
  if (!packRoot || !packRoot.trim()) {
    return path.join(KNOWLEDGE_PACKAGE_ROOT, DEFAULT_OFFLINE_PACK_RELPATH);
  }
  return path.isAbsolute(packRoot)
    ? packRoot
    : path.resolve(KNOWLEDGE_PACKAGE_ROOT, packRoot);
}

/**
 * Wrap a pack connector in the CK-09 conformance harness controls
 * (network deny + injectable clock).
 */
export function createPackKnowledgeConformanceHarness(
  connector: PackKnowledgeConnector,
  initialNowMs: number = KNOWLEDGE_CHECK_CLOCK_MS,
): KnowledgeConformanceHarness {
  let networkAllowed = true;
  let now = initialNowMs;
  return {
    knowledge: connector,
    isNetworkAllowed: () => networkAllowed,
    setNetworkAllowed: (allowed) => {
      networkAllowed = allowed;
    },
    nowMs: () => now,
    setNowMs: (ms) => {
      now = ms;
    },
  };
}

/**
 * Prove bundled-offline pack retrieve under B1 egress recording + CK-09.2.
 */
export async function proveOfflinePackRetrieve(
  options: ProveOfflinePackRetrieveOptions = {},
): Promise<ProveOfflinePackRetrieveResult> {
  const subjectId = options.subjectId?.trim() || "subj.pack.offline";
  const deviceId = options.deviceId?.trim() || "dev-pack-offline";
  const packRoot = resolvePackRoot(options.packRoot);
  const nowMs = options.nowMs ?? Date.parse("2026-07-15T00:00:00.000Z");
  const failures: string[] = [];

  emitProof(options.onTelemetry, { outcome: "start", subjectId, deviceId });

  let packId = "";
  let locality = "";
  let asOf = "";
  let passageCount = 0;
  let egressAttemptCount = 0;
  let localityOk = false;
  let ck092Ok = false;
  let citationsResolvable = false;
  let subjectIsolationOk = false;

  try {
    const { turn } = await withEgressRecordingTurn(
      {
        subjectId,
        deviceId,
        caller: { principalId: "principal.pack.offline", subjectScope: "*" },
      },
      async () => {
        const connector = PackKnowledgeConnector.load({
          packRoot,
          subjectId,
          deviceId,
          nowMs,
          ...(options.onTelemetry !== undefined
            ? { onTelemetry: options.onTelemetry }
            : {}),
        });

        const desc = connector.describe();
        packId = desc.packId ?? connector.packId;
        locality = desc.locality;
        asOf = desc.asOf;

        if (desc.locality !== "bundled-offline") {
          failures.push(
            `expected bundled-offline locality, got ${desc.locality}`,
          );
        }

        // Explicit network deny on the harness (CK-09.2 surface).
        const harness = createPackKnowledgeConformanceHarness(connector, nowMs);
        harness.setNetworkAllowed(false);

        const offlineSources = desc.sources
          .filter((s) => s.locality === "bundled-offline")
          .map((s) => s.sourceId);

        const probe = {
          query: `probe.ck09.2.offline.${subjectId.replace(/[^A-Za-z0-9._-]/g, ".")}`,
          limit: 8,
        };
        const passages = await connector.retrieve({
          ...probe,
          ...(offlineSources.length > 0 ? { sourceIds: offlineSources } : {}),
          limit: 8,
        });
        passageCount = passages.length;

        if (passages.length === 0) {
          failures.push(
            "bundled-offline retrieve returned no passages while network denied",
          );
        }

        const known = new Set(desc.sources.map((s) => s.sourceId));
        let citesOk = true;
        for (const p of passages) {
          if (!p.citation?.trim() || !known.has(p.sourceId)) {
            citesOk = false;
            failures.push(
              `passage sourceId=${p.sourceId} citation unresolved via describe().sources`,
            );
            break;
          }
        }
        citationsResolvable = citesOk && passages.length > 0;

        const isoEvents: PackLoaderTelemetry[] = [];
        PackKnowledgeConnector.load({
          packRoot,
          subjectId: `${subjectId}.peer`,
          deviceId: `${deviceId}.peer`,
          nowMs,
          onTelemetry: (e) => {
            if (
              e &&
              typeof e === "object" &&
              "event" in e &&
              e.event === "bindings_knowledge.pack_loader"
            ) {
              isoEvents.push(e as PackLoaderTelemetry);
            }
          },
        });
        subjectIsolationOk =
          isoEvents.length > 0 &&
          isoEvents.every((e) => e.subjectId === `${subjectId}.peer`);
        if (subjectIsolationOk) {
          emitProof(options.onTelemetry, {
            outcome: "subject_isolation_ok",
            subjectId,
            deviceId,
            packId,
          });
        } else {
          failures.push("subject isolation breached on peer load telemetry");
        }

        return { harness };
      },
    );

    egressAttemptCount = turn.attempts.length;
    const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
    localityOk = asserted.ok === true && turn.noEgress === true;
    if (!localityOk) {
      failures.push(
        `locality breach: attempts=${egressAttemptCount} ok=${asserted.ok}`,
      );
      emitProof(options.onTelemetry, {
        outcome: "egress_fail",
        subjectId,
        deviceId,
        packId,
        egressAttemptCount,
        detail: `egress attempts=${egressAttemptCount}`,
      });
    }

    // CK-09.2 (+ CK-09.3) via the standard obligation registry.
    const registryReport = await runConformance({
      registry: createOfflineStalenessObligationRegistry(),
      factory: () =>
        createPackKnowledgeConformanceHarness(
          PackKnowledgeConnector.load({
            packRoot,
            subjectId: `${subjectId}.ck09`,
            deviceId: `${deviceId}.ck09`,
            nowMs,
          }),
          KNOWLEDGE_CHECK_CLOCK_MS,
        ),
      subjectId: `${subjectId}.ck09`,
      deviceId: `${deviceId}.ck09`,
    });
    const ck092Verdict = registryReport.verdicts.find(
      (v) => v.obligationId === KNOWLEDGE_OBLIGATION_IDS.bundledOffline,
    );
    ck092Ok = ck092Verdict?.outcome === "pass";
    if (!ck092Ok) {
      failures.push(
        `CK-09.2 obligation not pass (exit=${registryReport.exitCode}): ${ck092Verdict?.message ?? "missing verdict"}`,
      );
      emitProof(options.onTelemetry, {
        outcome: "ck09_fail",
        subjectId,
        deviceId,
        packId,
        detail: ck092Verdict?.message ?? "CK-09.2 failed",
      });
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  const ok =
    failures.length === 0 &&
    localityOk &&
    ck092Ok &&
    citationsResolvable &&
    subjectIsolationOk &&
    passageCount > 0;

  emitProof(options.onTelemetry, {
    outcome: ok ? "pass" : "fail",
    subjectId,
    deviceId,
    ...(packId ? { packId } : {}),
    egressAttemptCount,
    ...(ok ? {} : { detail: failures[0] }),
  });

  return {
    ok,
    subjectId,
    deviceId,
    packId,
    locality,
    asOf,
    passageCount,
    egressAttemptCount,
    localityOk,
    ck092Ok,
    citationsResolvable,
    subjectIsolationOk,
    failures,
  };
}

