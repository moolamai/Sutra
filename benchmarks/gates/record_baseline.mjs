/**
 * Record gates/baseline.json from a green local/main capture.
 *
 * Never runs in CI as a write step — CI only *consumes* the committed baseline.
 * Update procedure is printed by --help and stored in the baseline `note` field.
 *
 * Usage (from benchmarks/):
 *   node gates/record_baseline.mjs           # write after green absolute gate
 *   node gates/record_baseline.mjs --dry-run # print JSON only
 *   node gates/record_baseline.mjs --help
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_UPDATE_NOTE,
  buildBaselineDocument,
} from "../_shared/bench.mjs";
import {
  DEFAULT_BENCHMARKS_DIR,
  DEFAULT_THRESHOLDS_PATH,
  loadThresholds,
  runBenchGate,
} from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BASELINE_OUT = path.join(__dirname, "baseline.json");

export function emitRecordTelemetry(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.baseline.record", ...event })}\n`,
  );
}

/**
 * Capture max p95 per bench file, build baseline document.
 * Requires absolute gate green first (NFR ceilings) — never records a red tree.
 */
export async function recordBaselineCapture(opts = {}) {
  const thresholdsPath = opts.thresholdsPath ?? DEFAULT_THRESHOLDS_PATH;
  const benchmarksDir = opts.benchmarksDir ?? DEFAULT_BENCHMARKS_DIR;
  const outPath = opts.outPath ?? DEFAULT_BASELINE_OUT;
  const dryRun = opts.dryRun === true;
  const deviceId = opts.deviceId ?? "green-main-capture";
  const subjectId = opts.subjectId ?? null;
  const executeBench = opts.executeBench;

  const loaded = await loadThresholds(thresholdsPath);
  if (!loaded.ok) {
    return loaded;
  }

  // Absolute gate must be green before we promote measurements to baseline.
  const absolute = await runBenchGate({
    thresholdsPath,
    benchmarksDir,
    subjectId,
    deviceId,
    ...(executeBench ? { executeBench } : {}),
  });
  if (!absolute.ok) {
    emitRecordTelemetry({
      outcome: "rejected",
      failureClass: absolute.failureClass,
      subjectId,
      deviceId,
      detail: "absolute gate red — refuse to record baseline",
    });
    return {
      ok: false,
      failureClass: absolute.failureClass ?? "p95_breach",
      detail:
        `refusing to record baseline while absolute gate is red: ${absolute.detail}`,
      absolute,
    };
  }

  const benchIds = absolute.benchIds;
  const measurements = {};
  const nfrByBench = {};
  for (const benchId of benchIds) {
    const entry = loaded.document.benches[benchId];
    nfrByBench[benchId] = entry.nfrId;
    const row = absolute.rows.find((r) => r.benchId === benchId);
    if (!row?.ok || typeof row.measuredP95 !== "number") {
      return {
        ok: false,
        failureClass: "bench_failed",
        detail: `no measured p95 for ${benchId}`,
      };
    }
    measurements[benchId] = row.measuredP95;
  }

  const document = buildBaselineDocument({
    measurements,
    deviceId,
    subjectId,
    nfrByBench,
    note: BASELINE_UPDATE_NOTE,
    recordedAt: new Date().toISOString(),
  });

  emitRecordTelemetry({
    outcome: "ok",
    action: "capture",
    subjectId,
    deviceId,
    benchCount: benchIds.length,
    dryRun,
  });

  const json = `${JSON.stringify(document, null, 2)}\n`;
  if (!dryRun) {
    await writeFile(outPath, json, "utf8");
    emitRecordTelemetry({
      outcome: "ok",
      action: "write",
      subjectId,
      deviceId,
      path: outPath,
    });
  } else {
    process.stdout.write(json);
  }

  // Verify relative gate against the freshly recorded document (in-memory).
  const verify = await runBenchGate({
    thresholdsPath,
    benchmarksDir,
    subjectId,
    deviceId: `${deviceId}-verify`,
    baselineDocument: document,
    executeBench:
      executeBench ??
      (async (benchId, entry) => {
        // Reuse captured measurements — idempotent verify without second long run.
        return {
          ok: true,
          benchId,
          measuredP95: measurements[benchId],
          samples: [],
          subjectId,
          deviceId,
        };
      }),
  });
  if (!verify.ok) {
    return {
      ok: false,
      failureClass: verify.failureClass,
      detail: `recorded baseline fails self-verify: ${verify.detail}`,
      document,
      outPath,
    };
  }

  return {
    ok: true,
    document,
    outPath,
    dryRun,
    measurements,
  };
}

function printHelp() {
  process.stdout.write(`record_baseline.mjs — capture gates/baseline.json

${BASELINE_UPDATE_NOTE}

Flags:
  --dry-run   Print JSON to stdout; do not write the file
  --help      Show this help
`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  const dryRun = argv.includes("--dry-run");
  const result = await recordBaselineCapture({ dryRun });
  if (!result.ok) {
    process.stderr.write(`baseline.record FAIL: ${result.detail}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    dryRun
      ? "baseline.record OK (dry-run)\n"
      : `baseline.record OK wrote ${result.outPath}\n`,
  );
  process.exitCode = 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    emitRecordTelemetry({
      outcome: "rejected",
      failureClass: "bench_failed",
      subjectId: null,
      deviceId: "baseline-record-cli",
      detail: err instanceof Error ? err.message : "unhandled",
    });
    process.exitCode = 1;
  });
}
