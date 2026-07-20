/**
 * Consistency gate for the field pilot kit (device matrix, offline bundle,
 * consent + friction telemetry configuration).
 *
 * Usage (repo root):
 *   node scripts/check-field-pilot-kit.mjs
 *   pnpm field-pilot-kit:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const KIT_DOC = path.join(REPO_ROOT, "docs", "pilot", "FIELD-PILOT-KIT.md");
export const OFFLINE_EDGE_README = path.join(
  REPO_ROOT,
  "examples",
  "offline-edge",
  "README.md",
);
export const TELEMETRY_README = path.join(
  REPO_ROOT,
  "packages",
  "telemetry",
  "README.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_KIT: "field_pilot.kit.missing_doc",
  MISSING_SECTION: "field_pilot.kit.missing_section",
  MISSING_PATH: "field_pilot.kit.missing_path",
  MISSING_LINK: "field_pilot.kit.missing_readme_link",
  PRIVACY: "field_pilot.kit.privacy_invariant",
  SUBJECT_SCOPE: "field_pilot.kit.subject_isolation",
  CONSENT: "field_pilot.kit.consent_config",
  TELEMETRY_DOC: "field_pilot.kit.telemetry_readme",
});

/** Paths the kit must name that must exist on disk. */
export const REQUIRED_REPO_PATHS = Object.freeze([
  "packages/domain-loader/fixtures/packs/teacher-cbse-slice.json",
  "packages/bindings-slm/certification/registry.json",
  "packages/bindings-slm/android/certification/reports/android.cert.json",
  "packages/bindings-slm/macos/certification/reports/apple-silicon.cert.json",
  "packages/bindings-slm/certification/reports/certification.report.json",
  "examples/offline-edge/main.mjs",
  "packages/telemetry/README.md",
  "packages/telemetry/src/collector.ts",
]);

/** Content obligations in FIELD-PILOT-KIT.md */
export const REQUIRED_KIT_PATTERNS = Object.freeze([
  { id: "android-mid", re: /android-mid/ },
  { id: "apple-silicon", re: /apple-silicon/ },
  { id: "teacher-pack", re: /teacher-cbse-slice@1\.0\.0/ },
  { id: "onnx", re: /\bonnx\b/i },
  { id: "mlx", re: /\bmlx\b/i },
  { id: "offline-edge", re: /offline-edge/ },
  { id: "no-raw-keystroke", re: /never raw keystroke|no raw keystroke/i },
  { id: "subjectId", re: /subjectId/ },
  { id: "deviceId", re: /deviceId/ },
  { id: "idempotent", re: /idempotent/i },
  { id: "concurrent", re: /[Cc]oncurrent turns/ },
  { id: "verified-date", re: /Verified[*\s|:]*20\d{2}-\d{2}-\d{2}/ },
  { id: "cast-05", re: /CAST-05\.1/ },
  { id: "bindings-speech", re: /bindings-speech/ },
  { id: "bindings-vision", re: /bindings-vision/ },
  { id: "consent-schema", re: /field-pilot\.consent\.v1/ },
  { id: "markSynced", re: /markSynced/ },
  { id: "write-ahead", re: /write-ahead/i },
  { id: "unsynced", re: /unsynced/ },
  { id: "operator-checklist", re: /Operator checklist/i },
  { id: "leaves-device", re: /[Ww]hat leaves the device|Leaves device/ },
  { id: "stays-sovereign", re: /[Ss]tays sovereign|stays sovereign/ },
  { id: "trajectory-false", re: /trajectoryExport["']?\s*:\s*false|trajectoryExport.*false/ },
]);

/** Telemetry README must document consent + markSynced for implementors. */
export const REQUIRED_TELEMETRY_PATTERNS = Object.freeze([
  { id: "field-pilot-kit-link", re: /FIELD-PILOT-KIT\.md/ },
  { id: "markSynced", re: /markSynced/ },
  { id: "consent", re: /consent/i },
  { id: "no-raw", re: /[Rr]aw keystroke|raw content never/i },
  { id: "write-ahead", re: /write-ahead/i },
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "field_pilot.kit.check", ...event })}\n`,
  );
}

/**
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function checkFieldPilotKit({
  kitPath = KIT_DOC,
  offlineEdgeReadme = OFFLINE_EDGE_README,
  telemetryReadme = TELEMETRY_README,
  repoRoot = REPO_ROOT,
} = {}) {
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(kitPath)) {
    failures.push(`${OBLIGATIONS.MISSING_KIT}: ${kitPath}`);
    emit({
      outcome: "fail",
      failureClass: OBLIGATIONS.MISSING_KIT,
      subjectId: "field-pilot-kit",
      deviceId: "ci",
    });
    return { ok: false, failures };
  }

  const body = readFileSync(kitPath, "utf8");

  for (const { id, re } of REQUIRED_KIT_PATTERNS) {
    if (!re.test(body)) {
      failures.push(`${OBLIGATIONS.MISSING_SECTION}: kit missing pattern ${id}`);
    }
  }

  if (!/behavioral metadata/i.test(body) || !/keystroke/i.test(body)) {
    failures.push(
      `${OBLIGATIONS.PRIVACY}: kit must state behavioral metadata only / no raw keystrokes`,
    );
  }

  if (!/subjectId/.test(body) || !/deviceId/.test(body)) {
    failures.push(
      `${OBLIGATIONS.SUBJECT_SCOPE}: kit must scope turns by subjectId and deviceId`,
    );
  }

  if (
    !/field-pilot\.consent\.v1/.test(body) ||
    !/markSynced/.test(body) ||
    !/frictionSampleSync/.test(body)
  ) {
    failures.push(
      `${OBLIGATIONS.CONSENT}: kit must document consent.v1, markSynced, frictionSampleSync`,
    );
  }

  for (const rel of REQUIRED_REPO_PATHS) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      failures.push(`${OBLIGATIONS.MISSING_PATH}: ${rel}`);
    }
  }

  for (const [label, readmePath] of [
    ["offline-edge", offlineEdgeReadme],
    ["telemetry", telemetryReadme],
  ]) {
    if (!existsSync(readmePath)) {
      failures.push(`${OBLIGATIONS.MISSING_LINK}: ${label} README missing`);
      continue;
    }
    const readme = readFileSync(readmePath, "utf8");
    if (!/FIELD-PILOT-KIT\.md/.test(readme)) {
      failures.push(
        `${OBLIGATIONS.MISSING_LINK}: ${label} README must link FIELD-PILOT-KIT.md`,
      );
    }
  }

  if (existsSync(telemetryReadme)) {
    const tel = readFileSync(telemetryReadme, "utf8");
    for (const { id, re } of REQUIRED_TELEMETRY_PATTERNS) {
      if (!re.test(tel)) {
        failures.push(
          `${OBLIGATIONS.TELEMETRY_DOC}: telemetry README missing pattern ${id}`,
        );
      }
    }
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    failureClass: ok ? undefined : failures[0]?.split(":")[0],
    subjectId: "field-pilot-kit",
    deviceId: "ci",
    failureCount: failures.length,
  });
  return { ok, failures };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = checkFieldPilotKit();
  if (!result.ok) {
    for (const f of result.failures) {
      console.error(f);
    }
    process.exitCode = 1;
  }
}
