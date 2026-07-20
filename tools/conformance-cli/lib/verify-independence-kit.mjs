/**
 * Verify an extracted independence-kit directory (fixtures + checklist).
 * Emits structured verify events (subjectId / deviceId / outcome — no content).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const REQUIRED_SYNC_DIRS = Object.freeze([
  "wire-parity",
  "golden-joins",
  "golden-turns",
  "tool-envelope",
  "advisories",
  "degradation-registry",
]);

export const REQUIRED_CHECKLIST_MARKERS = Object.freeze([
  "SYNC-01.1",
  "SYNC-01.2",
  "CK-03.1",
  "CK-03.2",
  "CK-03.3",
  "CK-03.L1",
  "CK-03.L2",
  "Harness stream",
  "subjectId",
  "never",
]);

/** Patterns that must not appear as raw learner bodies in the checklist. */
const FORBIDDEN_CONTENT_PATTERNS = [
  /"delta"\s*:\s*"[^"]{40,}"/,
  /utterance\s*[:=]\s*["'][^"']{20,}/i,
  /prompt\s*[:=]\s*["'][^"']{40,}/i,
];

/**
 * @typedef {object} KitVerifyEvent
 * @property {"independence_kit.verify"} event
 * @property {"pass"|"fail"} outcome
 * @property {string} subjectId
 * @property {string} [deviceId]
 * @property {string} [code]
 * @property {string} [detail]
 */

/**
 * @typedef {object} KitVerifyResult
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {object|null} manifest
 * @property {KitVerifyEvent[]} events
 */

/**
 * @param {string} kitRoot absolute or relative path to extracted kit
 * @param {{ subjectId?: string, deviceId?: string, emit?: (e: KitVerifyEvent) => void }} [options]
 * @returns {KitVerifyResult}
 */
export function verifyIndependenceKit(kitRoot, options = {}) {
  const subjectId = options.subjectId ?? "kit.verify";
  const deviceId = options.deviceId ?? "local";
  /** @type {string[]} */
  const errors = [];
  /** @type {KitVerifyEvent[]} */
  const events = [];

  const emit = (partial) => {
    /** @type {KitVerifyEvent} */
    const event = {
      event: "independence_kit.verify",
      subjectId,
      deviceId,
      ...partial,
    };
    events.push(event);
    options.emit?.(event);
  };

  if (!kitRoot || typeof kitRoot !== "string") {
    errors.push("kit root path required");
    emit({ outcome: "fail", code: "KIT_ROOT_MISSING" });
    return { ok: false, errors, manifest: null, events };
  }

  const root = path.resolve(kitRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    errors.push(`kit root is not a directory: ${root}`);
    emit({ outcome: "fail", code: "KIT_ROOT_INVALID" });
    return { ok: false, errors, manifest: null, events };
  }

  const checklistPath = path.join(root, "CERTIFICATION-CHECKLIST.md");
  const manifestPath = path.join(root, "MANIFEST.json");
  const wireBundle = path.join(root, "wire", "bundle.json");
  const crossSubject = path.join(
    root,
    "sync",
    "golden-joins",
    "20-subject-isolation-refused.json",
  );

  if (!existsSync(checklistPath)) {
    errors.push("missing CERTIFICATION-CHECKLIST.md");
  }
  if (!existsSync(manifestPath)) {
    errors.push("missing MANIFEST.json");
  }
  if (!existsSync(wireBundle)) {
    errors.push("missing wire/bundle.json");
  }
  for (const dir of REQUIRED_SYNC_DIRS) {
    const p = path.join(root, "sync", dir);
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      errors.push(`missing sync/${dir}/`);
    }
  }
  if (!existsSync(crossSubject)) {
    errors.push(
      "missing sync/golden-joins/20-subject-isolation-refused.json (subject isolation)",
    );
  }

  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest?.schemaVersion !== "independence-kit.manifest.v1") {
        errors.push("MANIFEST schemaVersion mismatch");
      }
      const obs = manifest?.obligations ?? {};
      for (const id of ["SYNC-01.1", "SYNC-01.2"]) {
        if (!obs.sync?.includes(id)) {
          errors.push(`MANIFEST missing sync obligation ${id}`);
        }
      }
      for (const id of ["CK-03.1", "CK-03.2", "CK-03.3"]) {
        if (!obs.binding?.includes(id)) {
          errors.push(`MANIFEST missing binding obligation ${id}`);
        }
      }
      for (const id of ["CK-03.L1", "CK-03.L2"]) {
        if (!obs.locality?.includes(id)) {
          errors.push(`MANIFEST missing locality obligation ${id}`);
        }
      }
      if (!Array.isArray(obs.harness) || obs.harness.length === 0) {
        errors.push("MANIFEST missing harness coverage");
      }
    } catch {
      errors.push("MANIFEST.json is not valid JSON");
      manifest = null;
    }
  }

  if (existsSync(checklistPath)) {
    const text = readFileSync(checklistPath, "utf8");
    for (const marker of REQUIRED_CHECKLIST_MARKERS) {
      if (!text.includes(marker)) {
        errors.push(`checklist missing required marker: ${marker}`);
      }
    }
    for (const re of FORBIDDEN_CONTENT_PATTERNS) {
      if (re.test(text)) {
        errors.push("checklist embeds raw content body (sovereignty)");
        break;
      }
    }
  }

  if (existsSync(wireBundle)) {
    try {
      const bundle = JSON.parse(readFileSync(wireBundle, "utf8"));
      if (!bundle?.valid || typeof bundle.valid !== "object") {
        errors.push("wire/bundle.json missing valid SyncRequest");
      }
    } catch {
      errors.push("wire/bundle.json is not valid JSON");
    }
  }

  const ok = errors.length === 0;
  emit({
    outcome: ok ? "pass" : "fail",
    code: ok ? "KIT_OK" : "KIT_INVALID",
    detail: ok ? undefined : errors[0],
  });
  return { ok, errors, manifest, events };
}
