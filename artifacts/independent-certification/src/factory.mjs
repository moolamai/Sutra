/**
 * Independent implementor factory — switches harness by obligationId.
 * Storage + model are local to this artifact (not monorepo reference stacks).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileBackedMemoryBackend } from "./storage.mjs";
import { createIndependentModel } from "./model.mjs";
import { createIndependentLocalityHarness } from "./locality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/** Checklist-covered obligation set for the independence-kit certification run. */
export const CERTIFICATION_OBLIGATION_IDS = Object.freeze([
  "SYNC-01.1",
  "SYNC-01.2",
  "CK-02.1",
  "CK-02.2",
  "CK-02.3",
  "CK-03.1",
  "CK-03.2",
  "CK-03.3",
  "CK-03.L1",
  "CK-03.L2",
]);

/**
 * @param {{ dataDir?: string, kitWireBundle?: string, seedMode?: "good"|"cross-subject-sync"|"hang"|"unstable-embed" }} [options]
 */
export function createIndependentCertificationFactory(options = {}) {
  const dataDir =
    options.dataDir ?? path.join(ROOT, "data", `run-${process.pid}`);
  const backend = createFileBackedMemoryBackend(dataDir);
  const seedMode = options.seedMode ?? "good";

  const wireBundlePath =
    options.kitWireBundle ??
    path.join(
      ROOT,
      "..",
      "..",
      "packages",
      "contract-conformance",
      "fixtures",
      "independence-kit",
      "wire",
      "bundle.json",
    );

  function loadValidSync(subjectId) {
    if (!existsSync(wireBundlePath)) {
      throw new Error(`wire bundle missing: ${wireBundlePath}`);
    }
    const bundle = JSON.parse(readFileSync(wireBundlePath, "utf8"));
    const payload = structuredClone(bundle.valid);
    const edge = structuredClone(payload.edgeState);
    edge.subjectId =
      seedMode === "cross-subject-sync" ? `${subjectId}::other` : subjectId;
    // Align to frozen schema const (golden envelopes may drift ahead of freeze).
    const schemaVersion =
      bundle.schema?.properties?.protocolVersion?.const ??
      bundle.schemaProtocolVersion ??
      payload.protocolVersion;
    if (schemaVersion) {
      payload.protocolVersion = schemaVersion;
      edge.protocolVersion = schemaVersion;
    }
    payload.edgeState = edge;
    return payload;
  }

  return async function factory(ctx) {
    const { obligationId, subjectId } = ctx;

    if (seedMode === "hang") {
      return new Promise(() => {});
    }

    if (obligationId.startsWith("SYNC-01")) {
      return {
        produceSyncRequest(scopeCtx) {
          const payload = loadValidSync(scopeCtx.subjectId);
          // Idempotent replay: same syncAttemptId applies once.
          backend.syncLedger.applyOnce(payload.syncAttemptId, () => {});
          return payload;
        },
      };
    }

    if (obligationId.startsWith("CK-02")) {
      const open = () => backend.open();
      return {
        memory: open(),
        async reinstantiate() {
          return backend.restart();
        },
        nowMs: () => backend.nowMs(),
        setNowMs: (ms) => backend.setNowMs(ms),
      };
    }

    if (
      obligationId === "CK-03.1" ||
      obligationId === "CK-03.2" ||
      obligationId === "CK-03.3"
    ) {
      return createIndependentModel({
        locality: "on-device",
        unstableEmbed: seedMode === "unstable-embed",
      });
    }

    if (obligationId === "CK-03.L1" || obligationId === "CK-03.L2") {
      return createIndependentLocalityHarness("compliant");
    }

    throw new Error(`unsupported obligation for independent factory: ${obligationId}`);
  };
}

/** Default export for `conformance --factory`. */
const defaultFactory = createIndependentCertificationFactory();
export default defaultFactory;
