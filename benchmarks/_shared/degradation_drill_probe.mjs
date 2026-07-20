/**
 * Degradation drills probe — cloud LLM down (ATR-05) + edge SLM weights failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ORCH_PKG = path.join(REPO_ROOT, "packages/cloud-orchestrator");
const EDGE_PKG = path.join(REPO_ROOT, "packages/edge-agent");
const DRILL_PY = path.join(__dirname, "cloud_llm_down_drill.py");

/** Bounded concurrent same-subject degrade turns for isolation/race drills. */
export const DEGRADE_CONCURRENCY_CAP = 4;

function emitTelemetry(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.degradation_drill", ...event })}\n`,
  );
}

/**
 * @param {object} [opts]
 * @param {string} [opts.subjectId]
 * @param {string} [opts.deviceId]
 * @param {string} [opts.utterance]
 * @param {"turn"|"http"|"concurrent"|"sovereignty"} [opts.mode]
 */
export function runCloudLlmDownDrill(opts = {}) {
  const subjectId = opts.subjectId ?? "subj-degr-llm";
  const deviceId = opts.deviceId ?? "edge-degr-llm";
  const utterance = opts.utterance ?? "what is a ratio?";
  const mode = opts.mode ?? "turn";

  const env = {
    ...process.env,
    SUTRA_DEGR_SUBJECT: subjectId,
    SUTRA_DEGR_DEVICE: deviceId,
    SUTRA_DEGR_UTTERANCE: utterance,
    SUTRA_DEGR_MODE: mode,
    PYTHONPATH: [path.join(ORCH_PKG, "src"), process.env.PYTHONPATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter),
  };

  const py = spawnSync(process.env.SUTRA_PYTHON ?? "python", [DRILL_PY], {
    cwd: ORCH_PKG,
    env,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });

  if (py.error) {
    return {
      ok: false,
      failureClass: "python_spawn",
      detail: String(py.error.message ?? py.error),
      subjectId,
      deviceId,
    };
  }
  if (py.status !== 0 && !(py.stdout || "").includes('"drill"')) {
    return {
      ok: false,
      failureClass: "python_exit",
      detail: (py.stderr || py.stdout || "").slice(0, 2000),
      subjectId,
      deviceId,
      status: py.status,
    };
  }

  const line = (py.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.includes('"drill"'))
    .pop();
  if (!line) {
    return {
      ok: false,
      failureClass: "missing_result",
      detail: (py.stdout || py.stderr || "").slice(0, 1000),
      subjectId,
      deviceId,
    };
  }

  let result;
  try {
    result = JSON.parse(line);
  } catch (err) {
    return {
      ok: false,
      failureClass: "json_parse",
      detail: String(err),
      subjectId,
      deviceId,
    };
  }

  emitTelemetry({
    outcome: result.ok ? "ok" : "fail",
    drill: "cloud_llm_down",
    subjectId: result.subjectId ?? subjectId,
    deviceId: result.deviceId ?? deviceId,
    httpStatus: result.httpStatus ?? null,
    degraded: result.degraded ?? null,
    failureClass: result.failureClass ?? null,
  });
  return result;
}

export function formatDegradationDrillReport(result) {
  const drill = result?.drill ?? "unknown";
  if (!result?.ok) {
    return `FAIL ${drill} ${result?.failureClass ?? "unknown"}`;
  }
  if (drill === "edge_slm_failure") {
    return `PASS edge_slm_failure class=${result.failureClass} attempts=${result.loadAttempts} crashLoop=${result.crashLoop}`;
  }
  return `PASS cloud_llm_down http=${result.httpStatus} degraded=${result.degraded} guide=${result.replyStartsWithGuide}`;
}

/**
 * Edge SLM missing/corrupt weights degradation drill.
 * @param {object} [opts]
 * @param {"missing"|"corrupt"|"recovery"|"sovereignty"|"concurrent"} [opts.mode]
 * @param {string} [opts.subjectId]
 * @param {string} [opts.deviceId]
 */
export async function runEdgeSlmFailureDrill(opts = {}) {
  const subjectId = opts.subjectId ?? "subj-degr-slm";
  const deviceId = opts.deviceId ?? "edge-degr-slm";
  const mode = opts.mode ?? "missing";

  const {
    LocalWeightSlmRuntime,
    SLM_WEIGHTS_MAGIC,
    SlmRuntimeInitError,
    EDGE_SLM_LOAD_OBLIGATION,
  } = await import(pathToFileURL(path.join(EDGE_PKG, "dist/index.js")).href);
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-degr-slm-"));
  const weightsPath = path.join(dir, "model.bin");
  const events = [];

  const card = {
    modelId: "phi-degr-q4",
    contextWindow: 2048,
    quantization: "q4",
    memoryFootprintMiB: 32,
    languages: ["en"],
  };

  /** @type {Record<string, unknown>} */
  let out = {
    drill: "edge_slm_failure",
    subjectId,
    deviceId,
    ok: false,
    fabricated: false,
  };

  try {
    if (mode === "missing") {
      const runtime = new LocalWeightSlmRuntime(card, {
        weightsPath,
        subjectId,
        deviceId,
        onTelemetry: (e) => events.push(e),
      });
      let caught = null;
      try {
        await runtime.load();
      } catch (err) {
        caught = err;
      }
      const typedOk =
        caught instanceof SlmRuntimeInitError &&
        caught.failureClass === "missing_weights" &&
        caught.obligationId === EDGE_SLM_LOAD_OBLIGATION;
      const telemOk = events.some(
        (e) =>
          e.event === "edge_agent.slm_runtime" &&
          e.outcome === "init_error" &&
          e.failureClass === "missing_weights" &&
          e.subjectId === subjectId,
      );
      out = {
        ...out,
        ok: typedOk && telemOk && runtime.loadAttemptCount === 1,
        failureClass: typedOk ? "missing_weights" : "unexpected",
        loadAttempts: runtime.loadAttemptCount,
        crashLoop: false,
        telemetryEmitted: telemOk,
      };
    } else if (mode === "corrupt") {
      writeFileSync(weightsPath, "GGUF-FAKE-CORRUPT");
      const runtime = new LocalWeightSlmRuntime(card, {
        weightsPath,
        subjectId,
        deviceId,
        onTelemetry: (e) => events.push(e),
      });
      for (let i = 0; i < 3; i += 1) {
        try {
          await runtime.load();
        } catch {
          /* expected */
        }
      }
      const telemCount = events.filter(
        (e) =>
          e.outcome === "init_error" && e.failureClass === "corrupt_weights",
      ).length;
      out = {
        ...out,
        ok:
          runtime.loadAttemptCount === 3 &&
          telemCount === 3 &&
          !runtime.isLoaded,
        failureClass: "corrupt_weights",
        loadAttempts: runtime.loadAttemptCount,
        crashLoop: runtime.loadAttemptCount !== 3,
        telemetryEmitted: telemCount === 3,
      };
    } else if (mode === "recovery") {
      writeFileSync(weightsPath, "bad");
      const runtime = new LocalWeightSlmRuntime(card, {
        weightsPath,
        subjectId,
        deviceId,
        onTelemetry: (e) => events.push(e),
      });
      try {
        await runtime.load();
      } catch {
        /* expected */
      }
      writeFileSync(weightsPath, `${SLM_WEIGHTS_MAGIC}\nok`);
      await runtime.load();
      out = {
        ...out,
        ok: runtime.isLoaded === true,
        failureClass: null,
        loadAttempts: runtime.loadAttemptCount,
        crashLoop: false,
        recovered: true,
        telemetryEmitted: events.some((e) => e.outcome === "ok"),
      };
    } else if (mode === "concurrent") {
      writeFileSync(weightsPath, "corrupt");
      const runtime = new LocalWeightSlmRuntime(card, {
        weightsPath,
        subjectId,
        deviceId,
        onTelemetry: (e) => events.push(e),
      });
      const results = await Promise.allSettled([
        runtime.load(),
        runtime.load(),
      ]);
      const allRejected = results.every((r) => r.status === "rejected");
      const typedOk = results.every(
        (r) =>
          r.status === "rejected" && r.reason instanceof SlmRuntimeInitError,
      );
      out = {
        ...out,
        ok: allRejected && typedOk && runtime.loadAttemptCount === 2,
        failureClass: "corrupt_weights",
        loadAttempts: runtime.loadAttemptCount,
        crashLoop: false,
        concurrent: 2,
        telemetryEmitted: events.length >= 2,
      };
    } else if (mode === "sovereignty") {
      const pathA = path.join(dir, "a.bin");
      const pathB = path.join(dir, "b.bin");
      writeFileSync(pathB, `${SLM_WEIGHTS_MAGIC}\nok`);
      const eventsA = [];
      const eventsB = [];
      const a = new LocalWeightSlmRuntime(card, {
        weightsPath: pathA,
        subjectId: `${subjectId}-a`,
        deviceId: `${deviceId}-a`,
        onTelemetry: (e) => eventsA.push(e),
      });
      const b = new LocalWeightSlmRuntime(card, {
        weightsPath: pathB,
        subjectId: `${subjectId}-b`,
        deviceId: `${deviceId}-b`,
        onTelemetry: (e) => eventsB.push(e),
      });
      let aErr = null;
      try {
        await a.load();
      } catch (err) {
        aErr = err;
      }
      await b.load();
      out = {
        ...out,
        ok:
          aErr instanceof SlmRuntimeInitError &&
          aErr.failureClass === "missing_weights" &&
          b.isLoaded === true &&
          eventsA.every((e) => e.subjectId === `${subjectId}-a`) &&
          eventsB.every((e) => e.subjectId === `${subjectId}-b`) &&
          !JSON.stringify(eventsA).includes(`${subjectId}-b`),
        failureClass: "missing_weights",
        loadAttempts: a.loadAttemptCount,
        crashLoop: false,
        contentLeak: false,
        telemetryEmitted: eventsA.length >= 1,
      };
    } else {
      out.failureClass = "unknown_mode";
    }
  } catch (err) {
    out.ok = false;
    out.failureClass = err?.name ?? "exception";
    out.detail = String(err?.message ?? err).slice(0, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  emitTelemetry({
    outcome: out.ok ? "ok" : "fail",
    drill: "edge_slm_failure",
    subjectId: out.subjectId,
    deviceId: out.deviceId,
    failureClass: out.failureClass ?? null,
    loadAttempts: out.loadAttempts ?? null,
  });
  return out;
}
