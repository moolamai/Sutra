/**
 * Field pilot exit review gate — privacy, markSynced audit, routing sign-off.
 *
 * Usage (repo root, after pnpm build for live markSynced audit):
 *   node scripts/check-field-pilot-exit-review.mjs
 *   pnpm field-pilot:exit-review
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FINDINGS_DIR,
  memoryDriver,
  listFindingsFiles,
} from "./run-field-pilot-execution.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const EXIT_REVIEW_DOC = path.join(
  REPO_ROOT,
  "docs",
  "pilot",
  "PILOT-EXIT-REVIEW.md",
);
export const COLLECTOR_SRC = path.join(
  REPO_ROOT,
  "packages",
  "telemetry",
  "src",
  "collector.ts",
);
export const PILOT_SUMMARY = path.join(REPO_ROOT, "docs", "pilot", "PILOT-SUMMARY.md");
export const FREEZE_RFC_DRAFT = path.join(
  REPO_ROOT,
  "docs",
  "pilot",
  "P7-FREEZE-RFC-DRAFT.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_EXIT: "field_pilot.exit.missing_review",
  PRIVACY_DOC: "field_pilot.exit.privacy_signoff",
  MARKSYNCED_DOC: "field_pilot.exit.marksynced_audit",
  ROUTING_DOC: "field_pilot.exit.routing_signoff",
  GAP_RFC: "field_pilot.exit.guidance_gap_rfc",
  COLLECTOR_PRIVACY: "field_pilot.exit.collector_privacy",
  MARKSYNCED_LIVE: "field_pilot.exit.marksynced_live",
  FINDING: "field_pilot.exit.missing_finding",
  TRAJECTORY: "field_pilot.exit.trajectory_forbidden",
  SUBJECT_SCOPE: "field_pilot.exit.subject_isolation",
  TELEMETRY: "field_pilot.exit.telemetry_unavailable",
});

/** Forbidden identifiers in collector source (content must never be persisted). */
export const FORBIDDEN_COLLECTOR_PATTERNS = Object.freeze([
  { id: "keystrokeText", re: /keystrokeText|rawKeystroke|keystroke_content/i },
  { id: "utteranceColumn", re: /utterance_text|utteranceText|raw_utterance/i },
  { id: "contentColumn", re: /\bcontent\s+TEXT\b/i },
]);

/** Required privacy / API patterns in collector.ts */
export const REQUIRED_COLLECTOR_PATTERNS = Object.freeze([
  { id: "charsDelta", re: /charsDelta/ },
  { id: "markSynced", re: /markSynced/ },
  { id: "writeAhead", re: /INSERT OR IGNORE|write-ahead|persist/i },
  { id: "noRawStance", re: /NEVER leave|never leave|behavioral metadata/i },
  { id: "schemaMetaOnly", re: /hesitation_ms|input_velocity|revision_count/ },
]);

export const REQUIRED_EXIT_PATTERNS = Object.freeze([
  { id: "privacy-signoff", re: /Telemetry privacy sign-off|no raw keystroke/i },
  { id: "markSynced-audit", re: /markSynced.*audit|`markSynced` audit/i },
  { id: "routing-signoff", re: /Routing quality sign-off/i },
  { id: "guidance-gaps", re: /Guidance eval gaps|RFC blocker/i },
  { id: "FP-002", re: /FP-002/ },
  { id: "signed-off", re: /Signed off/i },
  { id: "trajectory-false", re: /trajectoryExport.*false|trajectoryExport\*\*.*false/i },
  { id: "subjectId", re: /subjectId/ },
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "field_pilot.exit_review", ...event })}\n`,
  );
}

/**
 * Static audit of collector.ts privacy surface.
 */
export function auditCollectorPrivacy({
  collectorPath = COLLECTOR_SRC,
} = {}) {
  /** @type {string[]} */
  const failures = [];
  if (!existsSync(collectorPath)) {
    failures.push(`${OBLIGATIONS.COLLECTOR_PRIVACY}: collector.ts missing`);
    return { ok: false, failures };
  }
  const src = readFileSync(collectorPath, "utf8");
  for (const { id, re } of FORBIDDEN_COLLECTOR_PATTERNS) {
    if (re.test(src)) {
      failures.push(
        `${OBLIGATIONS.COLLECTOR_PRIVACY}: forbidden pattern ${id} in collector`,
      );
    }
  }
  for (const { id, re } of REQUIRED_COLLECTOR_PATTERNS) {
    if (!re.test(src)) {
      failures.push(
        `${OBLIGATIONS.COLLECTOR_PRIVACY}: collector missing ${id}`,
      );
    }
  }
  // input event must not accept a free-form text/body field alongside charsDelta
  if (/type:\s*"input"[\s\S]{0,120}\b(text|body|content)\s*:/m.test(src)) {
    failures.push(
      `${OBLIGATIONS.COLLECTOR_PRIVACY}: input event must not carry text/body/content`,
    );
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Live markSynced + restart survival audit (uses telemetry dist).
 */
export async function auditMarkSyncedLive(opts = {}) {
  /** @type {string[]} */
  const failures = [];
  const telemetryPath = path.join(
    REPO_ROOT,
    "packages",
    "telemetry",
    "dist",
    "index.js",
  );
  const syncPath = path.join(
    REPO_ROOT,
    "packages",
    "sync-protocol",
    "dist",
    "index.js",
  );
  if (!existsSync(telemetryPath) || !existsSync(syncPath)) {
    failures.push(
      `${OBLIGATIONS.TELEMETRY}: build telemetry + sync-protocol before exit review`,
    );
    return { ok: false, failures, unsyncedAfterReplay: -1 };
  }

  const [{ CognitiveTelemetryCollector }, { HlcClock }] = await Promise.all([
    import(pathToFileURL(telemetryPath).href),
    import(pathToFileURL(syncPath).href),
  ]);

  let wall = opts.startMs ?? 1_700_000_000_000;
  const nowMs = () => wall;
  const driver = opts.driver ?? memoryDriver();
  const collector = new CognitiveTelemetryCollector(
    driver,
    new HlcClock("exit-review-audit", nowMs),
    { nowMs },
  );
  await collector.initialize();

  collector.observe({
    type: "prompt-rendered",
    conceptId: "math.fractions",
    atMs: wall,
  });
  collector.observe({ type: "input", charsDelta: 6, atMs: wall + 200 });
  const sample = await collector.submitted("correct", wall + 500);
  if (!sample?.capturedAt) {
    failures.push(`${OBLIGATIONS.MARKSYNCED_LIVE}: write-ahead sample missing`);
    return { ok: false, failures, unsyncedAfterReplay: -1 };
  }

  const pending = await collector.unsynced();
  if (pending.length !== 1) {
    failures.push(
      `${OBLIGATIONS.MARKSYNCED_LIVE}: expected 1 unsynced before markSynced`,
    );
  }
  await collector.markSynced([sample.capturedAt]);
  await collector.markSynced([sample.capturedAt]); // idempotent replay
  const after = await collector.unsynced();
  if (after.length !== 0) {
    failures.push(
      `${OBLIGATIONS.MARKSYNCED_LIVE}: unsynced non-empty after idempotent markSynced`,
    );
  }

  // Partial abandon: no durable poison
  wall += 1000;
  collector.observe({
    type: "prompt-rendered",
    conceptId: "math.ratios",
    atMs: wall,
  });
  collector.observe({ type: "input", charsDelta: 2, atMs: wall + 50 });
  const durable = await collector.durableSampleCount();
  if (durable !== 1) {
    failures.push(
      `${OBLIGATIONS.MARKSYNCED_LIVE}: half-open exercise must not add durable rows (got ${durable})`,
    );
  }

  emit({
    outcome: failures.length === 0 ? "ok" : "fail",
    phase: "marksynced_live",
    subjectId: "subj.pilot.exit.review",
    deviceId: "dev-pilot-exit-ci",
    failureClass:
      failures.length === 0 ? undefined : OBLIGATIONS.MARKSYNCED_LIVE,
    unsyncedAfterReplay: after.length,
  });

  return {
    ok: failures.length === 0,
    failures,
    unsyncedAfterReplay: after.length,
  };
}

/**
 * @returns {Promise<{ ok: boolean, failures: string[] }>}
 */
export async function checkFieldPilotExitReview(opts = {}) {
  /** @type {string[]} */
  const failures = [];
  const exitPath = opts.exitReviewPath ?? EXIT_REVIEW_DOC;
  const collectorPath = opts.collectorPath ?? COLLECTOR_SRC;
  const findingsDir = opts.findingsDir ?? FINDINGS_DIR;
  const summaryPath = opts.summaryPath ?? PILOT_SUMMARY;
  const rfcPath = opts.rfcDraftPath ?? FREEZE_RFC_DRAFT;
  const skipLive = opts.skipLive === true;

  if (!existsSync(exitPath)) {
    failures.push(`${OBLIGATIONS.MISSING_EXIT}: PILOT-EXIT-REVIEW.md required`);
  } else {
    const body = readFileSync(exitPath, "utf8");
    for (const { id, re } of REQUIRED_EXIT_PATTERNS) {
      if (!re.test(body)) {
        failures.push(`${OBLIGATIONS.PRIVACY_DOC}: exit review missing ${id}`);
      }
    }
    if (!/Privacy invariants|privacy sign-off|No raw keystroke/i.test(body)) {
      failures.push(`${OBLIGATIONS.PRIVACY_DOC}: privacy sign-off incomplete`);
    }
    if (!/markSynced/i.test(body) || !/idempotent/i.test(body)) {
      failures.push(
        `${OBLIGATIONS.MARKSYNCED_DOC}: markSynced audit section incomplete`,
      );
    }
    if (!/Routing quality/i.test(body) || !/Signed off/i.test(body)) {
      failures.push(`${OBLIGATIONS.ROUTING_DOC}: routing sign-off incomplete`);
    }
    if (!/FP-002/.test(body)) {
      failures.push(`${OBLIGATIONS.GAP_RFC}: FP-002 must be cited`);
    } else {
      const closed =
        /Closed/i.test(body) &&
        (/hi-classroom-noise|fp002_classroom_noise|fixture/i.test(body) ||
          /re-test/i.test(body));
      const blocker = /RFC blocker|not waived/i.test(body);
      if (!closed && !blocker) {
        failures.push(
          `${OBLIGATIONS.GAP_RFC}: FP-002 must be Closed with fixture evidence or remain RFC blocker`,
        );
      }
    }
    if (!/subjectId/.test(body)) {
      failures.push(`${OBLIGATIONS.SUBJECT_SCOPE}: exit review must mention subjectId`);
    }
    emit({
      outcome: "ok",
      phase: "doc",
      subjectId: "subj.pilot.exit.review",
      deviceId: "dev-pilot-exit-ci",
    });
  }

  const privacy = auditCollectorPrivacy({ collectorPath });
  if (!privacy.ok) failures.push(...privacy.failures);
  else {
    emit({
      outcome: "ok",
      phase: "collector_privacy",
      subjectId: "subj.pilot.exit.review",
      deviceId: "dev-pilot-exit-ci",
    });
  }

  if (!skipLive) {
    const live = await auditMarkSyncedLive(opts);
    if (!live.ok) failures.push(...live.failures);
  }

  const findings = listFindingsFiles(findingsDir);
  const exitFinding = findings.find((f) => /exit-review/i.test(f));
  if (!exitFinding) {
    failures.push(
      `${OBLIGATIONS.FINDING}: dated exit-review finding required under findings/`,
    );
  } else {
    const fbody = readFileSync(path.join(findingsDir, exitFinding), "utf8");
    if (!/FP-004/.test(fbody)) {
      failures.push(`${OBLIGATIONS.FINDING}: exit finding must use FP-004`);
    }
    if (/trajectoryExport["']?\s*:\s*`?true/i.test(fbody)) {
      failures.push(`${OBLIGATIONS.TRAJECTORY}: exit finding must not enable trajectory`);
    }
  }

  if (existsSync(summaryPath)) {
    const summary = readFileSync(summaryPath, "utf8");
    if (!/PILOT-EXIT-REVIEW\.md|exit review/i.test(summary)) {
      failures.push(
        `${OBLIGATIONS.MISSING_EXIT}: PILOT-SUMMARY must link exit review`,
      );
    }
    if (!/FP-004/.test(summary)) {
      failures.push(`${OBLIGATIONS.FINDING}: PILOT-SUMMARY must index FP-004`);
    }
  }

  if (existsSync(rfcPath)) {
    const rfc = readFileSync(rfcPath, "utf8");
    if (!/FP-002/.test(rfc) || !/P1/i.test(rfc)) {
      failures.push(
        `${OBLIGATIONS.GAP_RFC}: freeze draft must cite FP-002 P1`,
      );
    } else {
      const closed = /Closed/i.test(rfc) && /fixture|hi-classroom-noise|fp002/i.test(rfc);
      const open = /Open|blocker/i.test(rfc);
      if (!closed && !open) {
        failures.push(
          `${OBLIGATIONS.GAP_RFC}: freeze draft must keep FP-002 disposition (Closed with fixture or open blocker)`,
        );
      }
    }
    if (!/PILOT-EXIT-REVIEW|exit review/i.test(rfc)) {
      failures.push(
        `${OBLIGATIONS.GAP_RFC}: freeze draft should cite exit review sign-off`,
      );
    }
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    phase: "complete",
    subjectId: "subj.pilot.exit.review",
    deviceId: "dev-pilot-exit-ci",
    failureClass: ok ? undefined : failures[0]?.split(":")[0],
    failureCount: failures.length,
  });
  return { ok, failures };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = await checkFieldPilotExitReview();
  if (!result.ok) {
    for (const f of result.failures) {
      console.error(f);
    }
    process.exitCode = 1;
  }
}
