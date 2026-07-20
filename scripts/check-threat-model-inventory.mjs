/**
 * Threat-model trust boundary inventory gate (P7 STRIDE — inventory slice).
 *
 * Asserts security/THREAT-MODEL.md and security/diagrams/* cover all four
 * surfaces with named TB-* crossings, metadata/content classification, and
 * at least one STRIDE category per crossing.
 *
 * Usage (repo root):
 *   node scripts/check-threat-model-inventory.mjs
 *   pnpm threat-model:inventory:check
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const THREAT_MODEL = path.join(REPO_ROOT, "security", "THREAT-MODEL.md");
export const DIAGRAMS_DIR = path.join(REPO_ROOT, "security", "diagrams");

export const OBLIGATIONS = Object.freeze({
  MISSING_THREAT_MODEL: "threat_model.inventory.missing_threat_model",
  MISSING_DIAGRAMS_DIR: "threat_model.inventory.missing_diagrams_dir",
  MISSING_DIAGRAM: "threat_model.inventory.missing_diagram",
  MISSING_SURFACE: "threat_model.inventory.missing_surface",
  MISSING_CROSSING: "threat_model.inventory.missing_crossing",
  CLASSIFICATION: "threat_model.inventory.missing_classification",
  STRIDE: "threat_model.inventory.missing_stride",
  SOVEREIGNTY: "threat_model.inventory.sovereignty_incomplete",
  OBSERVABILITY: "threat_model.inventory.observability_incomplete",
  RAW_CONTENT_LEAK: "threat_model.inventory.raw_content_crosses_locality",
});

/** Four P7 surfaces required by STRIMODE-001. */
export const REQUIRED_SURFACES = Object.freeze([
  "edge-turn",
  "cloud-agent",
  "sync-wire",
  "tool-sandbox",
]);

/** Named trust-boundary crossings — must appear in THREAT-MODEL.md. */
export const REQUIRED_CROSSING_IDS = Object.freeze([
  "TB-EDGE-01",
  "TB-EDGE-02",
  "TB-EDGE-03",
  "TB-EDGE-04",
  "TB-EDGE-05",
  "TB-EDGE-06",
  "TB-EDGE-07",
  "TB-EDGE-08",
  "TB-EDGE-09",
  "TB-EDGE-10",
  "TB-CLOUD-01",
  "TB-CLOUD-02",
  "TB-CLOUD-03",
  "TB-CLOUD-04",
  "TB-CLOUD-05",
  "TB-CLOUD-06",
  "TB-CLOUD-07",
  "TB-CLOUD-08",
  "TB-SYNC-01",
  "TB-SYNC-02",
  "TB-SYNC-03",
  "TB-SYNC-04",
  "TB-SYNC-05",
  "TB-SYNC-06",
  "TB-SYNC-07",
  "TB-SYNC-08",
  "TB-TOOL-01",
  "TB-TOOL-02",
  "TB-TOOL-03",
  "TB-TOOL-04",
  "TB-TOOL-05",
  "TB-TOOL-06",
  "TB-TOOL-07",
  "TB-TOOL-08",
]);

export const REQUIRED_DIAGRAMS = Object.freeze([
  "edge-turn-loop.mmd",
  "cloud-agent-sync-path.mmd",
  "sync-wire.mmd",
  "tool-sandbox-seam.mmd",
]);

const STRIDE_LETTERS = /(?:^|[\s,|])([STRIED])(?:[\s,|]|$)/;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "threat_model.inventory.check", ...event })}\n`,
  );
}

/**
 * Find the markdown table row containing a crossing ID.
 * @param {string} body
 * @param {string} crossingId
 */
export function rowForCrossing(body, crossingId) {
  const lines = body.split(/\r?\n/);
  return lines.find((line) => line.includes(crossingId) && line.startsWith("|"));
}

/**
 * @param {string} row
 */
export function rowHasClassification(row) {
  return /\bmetadata\b/i.test(row) || /\bcontent\b/i.test(row);
}

/**
 * @param {string} row
 */
export function rowHasStride(row) {
  return STRIDE_LETTERS.test(row);
}

/**
 * @param {{ threatModelPath?: string, diagramsDir?: string }} [opts]
 * @returns {{ ok: boolean, failures: string[], crossings: number, diagrams: string[] }}
 */
export function checkThreatModelInventory(opts = {}) {
  const threatModelPath = opts.threatModelPath ?? THREAT_MODEL;
  const diagramsDir = opts.diagramsDir ?? DIAGRAMS_DIR;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(threatModelPath)) {
    failures.push(`${OBLIGATIONS.MISSING_THREAT_MODEL}:${threatModelPath}`);
    return { ok: false, failures, crossings: 0, diagrams: [] };
  }

  const body = readFileSync(threatModelPath, "utf8");

  if (!existsSync(diagramsDir)) {
    failures.push(`${OBLIGATIONS.MISSING_DIAGRAMS_DIR}:${diagramsDir}`);
  }

  /** @type {string[]} */
  const diagrams = [];
  if (existsSync(diagramsDir)) {
    for (const name of REQUIRED_DIAGRAMS) {
      const full = path.join(diagramsDir, name);
      if (!existsSync(full)) {
        failures.push(`${OBLIGATIONS.MISSING_DIAGRAM}:${name}`);
      } else {
        diagrams.push(name);
        if (!body.includes(name)) {
          failures.push(`${OBLIGATIONS.MISSING_DIAGRAM}:link:${name}`);
        }
      }
    }
    const extras = readdirSync(diagramsDir).filter((f) => f.endsWith(".mmd"));
    for (const name of REQUIRED_DIAGRAMS) {
      if (!extras.includes(name) && !failures.some((f) => f.endsWith(name))) {
        failures.push(`${OBLIGATIONS.MISSING_DIAGRAM}:${name}`);
      }
    }
  }

  for (const surface of REQUIRED_SURFACES) {
    if (!body.includes(surface)) {
      failures.push(`${OBLIGATIONS.MISSING_SURFACE}:${surface}`);
    }
  }

  let crossingRows = 0;
  for (const id of REQUIRED_CROSSING_IDS) {
    const row = rowForCrossing(body, id);
    if (!row) {
      failures.push(`${OBLIGATIONS.MISSING_CROSSING}:${id}`);
      continue;
    }
    crossingRows += 1;
    if (!rowHasClassification(row)) {
      failures.push(`${OBLIGATIONS.CLASSIFICATION}:${id}`);
    }
    if (!rowHasStride(row)) {
      failures.push(`${OBLIGATIONS.STRIDE}:${id}`);
    }
  }

  const sovereigntyBlock =
    /## Sovereignty and subject isolation[\s\S]*?(?=##|$)/i.exec(body)?.[0] ?? "";
  if (
    !/subjectId/i.test(sovereigntyBlock) ||
    !/locality|on-device|self-hosted/i.test(sovereigntyBlock) ||
    !/cross-subject/i.test(sovereigntyBlock)
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  if (
    !/## Observability contract/i.test(body) ||
    !/subjectId/i.test(body) ||
    !/deviceId/i.test(body) ||
    !/never.*plaintext|metadata only/i.test(body)
  ) {
    failures.push(OBLIGATIONS.OBSERVABILITY);
  }

  // Sovereignty negative: document must not claim raw utterances cross sync wire.
  if (
    /raw\s+(learner|utterance|keystroke).*cross/i.test(body) &&
    !/never|not|no raw/i.test(body)
  ) {
    failures.push(OBLIGATIONS.RAW_CONTENT_LEAK);
  }

  const ok = failures.length === 0;
  return { ok, failures, crossings: crossingRows, diagrams };
}

function main() {
  const result = checkThreatModelInventory();
  emit({
    outcome: result.ok ? "ok" : "fail",
    crossings: result.crossings,
    diagrams: result.diagrams.length,
    failureCount: result.failures.length,
  });
  if (!result.ok) {
    for (const f of result.failures) {
      process.stderr.write(`${f}\n`);
    }
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
