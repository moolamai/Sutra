/**
 * Soak leak detection — sample RSS + open-handle/connection counts during load.
 * Gate fails if post-warmup monotonic growth exceeds tolerance (edge + orchestrator).
 * Metadata only — never learner content.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Full soak window (30 min) — override with SUTRA_SOAK_MS for CI. */
export const DEFAULT_SOAK_MS = 30 * 60 * 1000;

/** Sample interval (1 min) — override with SUTRA_SOAK_SAMPLE_MS. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;

/** Discard first N samples before leak math (warmup). */
export const DEFAULT_WARMUP_SAMPLES = 2;

/** Allowed RSS growth after warmup (bytes). */
export const DEFAULT_RSS_GROWTH_TOLERANCE_BYTES = 64 * 1024 * 1024;

/** Allowed open-handle / connection growth after warmup. */
export const DEFAULT_HANDLE_GROWTH_TOLERANCE = 32;

/** Compose orchestrator container name (infra/docker-compose.yml). */
export const ORCHESTRATOR_CONTAINER = "sutra-orchestrator";

/**
 * Edge harness resource sample — Node process RSS + active resource handles.
 */
export function sampleEdgeHarnessResources(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const mem = process.memoryUsage();
  let handleCount = 0;
  if (typeof process.getActiveResourcesInfo === "function") {
    handleCount = process.getActiveResourcesInfo().length;
  } else if (typeof process._getActiveHandles === "function") {
    handleCount = process._getActiveHandles().length;
  }
  return {
    target: "edge",
    atMs: nowMs,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    handleCount,
  };
}

/**
 * Orchestrator resources: docker stats when available; else client-side proxy
 * (outbound socket/handle pressure) so in-process CI still exercises the gate.
 */
export async function sampleOrchestratorResources(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const container = opts.containerName ?? ORCHESTRATOR_CONTAINER;
  const dockerSampler = opts.dockerSampler;
  const fallback = opts.fallbackSample;

  if (typeof dockerSampler === "function") {
    const fromDocker = await dockerSampler({ container, nowMs });
    if (fromDocker) return fromDocker;
  }

  if (opts.useDocker !== false) {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "stats",
          container,
          "--no-stream",
          "--format",
          "{{.MemUsage}}\t{{.NetIO}}",
        ],
        { timeout: 5_000, windowsHide: true },
      );
      const line = String(stdout).trim().split("\n")[0] ?? "";
      const [memPart, netPart] = line.split("\t");
      const rssBytes = parseDockerMemBytes(memPart?.split("/")[0]?.trim() ?? "");
      const handleCount = parseDockerNetConnections(netPart ?? "");
      if (Number.isFinite(rssBytes) && rssBytes > 0) {
        return {
          target: "orchestrator",
          atMs: nowMs,
          rssBytes,
          handleCount: Number.isFinite(handleCount) ? handleCount : 0,
          source: "docker_stats",
        };
      }
    } catch {
      // Compose absent — fall through.
    }
  }

  if (fallback && typeof fallback === "object") {
    return {
      target: "orchestrator",
      atMs: nowMs,
      rssBytes: Number(fallback.rssBytes) || 0,
      handleCount: Number(fallback.handleCount) || 0,
      source: "injected_fallback",
    };
  }

  // In-process floor: mirror edge handles as a bounded connection proxy
  // (no real container — leak gate still applied on edge harness).
  const edge = sampleEdgeHarnessResources({ nowMs });
  return {
    target: "orchestrator",
    atMs: nowMs,
    rssBytes: edge.rssBytes,
    handleCount: edge.handleCount,
    source: "in_process_proxy",
  };
}

/** Parse docker stats memory strings like "128.5MiB" / "1.2GiB". */
export function parseDockerMemBytes(raw) {
  if (typeof raw !== "string" || !raw.trim()) return NaN;
  const m = raw.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mult =
    unit.startsWith("GI") || unit === "GB"
      ? 1024 ** 3
      : unit.startsWith("MI") || unit === "MB"
        ? 1024 ** 2
        : unit.startsWith("KI") || unit === "KB"
          ? 1024
          : 1;
  return Math.round(n * mult);
}

/** Best-effort: treat cumulative RX+TX packet markers as connection pressure proxy. */
export function parseDockerNetConnections(raw) {
  if (typeof raw !== "string" || !raw.trim()) return 0;
  // "1.2kB / 800B" — use digit count of totals as weak proxy; prefer 0 when unparsable.
  const parts = raw.split("/").map((p) => p.trim());
  let total = 0;
  for (const p of parts) {
    const m = p.match(/^([\d.]+)/);
    if (m) total += Number(m[1]);
  }
  return Math.max(0, Math.round(total));
}

/**
 * Detect post-warmup monotonic leak: net growth from first post-warmup sample
 * to the series peak (and final) exceeds tolerance, with predominantly rising steps.
 */
export function evaluateMonotonicGrowth(samples, opts = {}) {
  const warmupSamples = opts.warmupSamples ?? DEFAULT_WARMUP_SAMPLES;
  const rssTolerance =
    opts.rssGrowthToleranceBytes ?? DEFAULT_RSS_GROWTH_TOLERANCE_BYTES;
  const handleTolerance =
    opts.handleGrowthTolerance ?? DEFAULT_HANDLE_GROWTH_TOLERANCE;
  const metricKey = opts.metricKey ?? "rssBytes";
  const target = opts.target ?? samples[0]?.target ?? "unknown";

  if (!Array.isArray(samples) || samples.length <= warmupSamples) {
    return {
      ok: false,
      failureClass: "insufficient_samples",
      target,
      metricKey,
      detail: `need > ${warmupSamples} samples, got ${samples?.length ?? 0}`,
      measuredGrowth: null,
      budget: metricKey === "handleCount" ? handleTolerance : rssTolerance,
    };
  }

  const post = samples.slice(warmupSamples);
  const baseline = post[0];
  const values = post.map((s) => Number(s[metricKey]));
  if (values.some((v) => !Number.isFinite(v))) {
    return {
      ok: false,
      failureClass: "validation_failed",
      target,
      metricKey,
      detail: "non-finite resource samples",
      measuredGrowth: null,
      budget: metricKey === "handleCount" ? handleTolerance : rssTolerance,
    };
  }

  const peak = Math.max(...values);
  const final = values[values.length - 1];
  const growthFromBaseline = Math.max(peak - values[0], final - values[0]);
  let risingSteps = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) risingSteps += 1;
  }
  const risingRatio = (values.length - 1) === 0 ? 0 : risingSteps / (values.length - 1);
  const tolerance =
    metricKey === "handleCount" ? handleTolerance : rssTolerance;

  // Leak = net growth over budget AND trend predominantly rising (monotonic pressure).
  const leak =
    growthFromBaseline > tolerance &&
    (risingRatio >= 0.5 || final - values[0] > tolerance);

  if (leak) {
    return {
      ok: false,
      failureClass: "leak_detected",
      target,
      metricKey,
      measuredGrowth: growthFromBaseline,
      budget: tolerance,
      baseline: values[0],
      peak,
      final,
      risingRatio,
      sampleCount: post.length,
      atMs: baseline.atMs,
    };
  }

  return {
    ok: true,
    failureClass: null,
    target,
    metricKey,
    measuredGrowth: growthFromBaseline,
    budget: tolerance,
    baseline: values[0],
    peak,
    final,
    risingRatio,
    sampleCount: post.length,
    headroom: tolerance - growthFromBaseline,
  };
}

/** Combine edge + orchestrator RSS/handle evaluations into one gate. */
export function evaluateSoakLeakGate(series, opts = {}) {
  const breaches = [];
  for (const [target, samples] of Object.entries(series)) {
    if (!Array.isArray(samples)) continue;
    for (const metricKey of ["rssBytes", "handleCount"]) {
      const row = evaluateMonotonicGrowth(samples, {
        ...opts,
        target,
        metricKey,
      });
      if (!row.ok) breaches.push(row);
    }
  }

  if (breaches.length === 0) {
    return { ok: true, breaches: [], seriesTargets: Object.keys(series) };
  }
  return {
    ok: false,
    failureClass: breaches[0].failureClass,
    breaches,
    seriesTargets: Object.keys(series),
  };
}

export function formatSoakLeakGateReport(gate, meta = {}) {
  const lines = ["---- soak leak gate ----"];
  if (meta.soakMs != null) lines.push(`soakMs=${meta.soakMs} sampleIntervalMs=${meta.sampleIntervalMs ?? "?"}`);
  if (meta.path) lines.push(`path=${meta.path}`);
  if (!gate.ok) {
    lines.push("FAIL");
    for (const b of gate.breaches ?? []) {
      lines.push(
        `  ${b.target}.${b.metricKey} measured_growth=${b.measuredGrowth ?? "n/a"} budget=${b.budget} class=${b.failureClass}`,
      );
    }
  } else {
    lines.push("PASS");
  }
  lines.push("------------------------");
  return `${lines.join("\n")}\n`;
}

export function emitSoakLeakTelemetry(event) {
  const { utterance: _u, text: _t, ...safe } = event;
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.soak_leak", ...safe })}\n`,
  );
}

/**
 * Run load cycles for soakMs while sampling edge + orchestrator resources.
 */
export async function runSoakWithLeakDetection(opts = {}) {
  const soakMs = opts.soakMs ?? DEFAULT_SOAK_MS;
  const sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const warmupSamples = opts.warmupSamples ?? DEFAULT_WARMUP_SAMPLES;
  const runLoadCycle = opts.runLoadCycle;
  const sampleEdge = opts.sampleEdge ?? sampleEdgeHarnessResources;
  const sampleOrchestrator = opts.sampleOrchestrator ?? sampleOrchestratorResources;
  const nowFn = opts.nowMs ?? (() => Date.now());
  const sleepFn =
    opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  if (typeof runLoadCycle !== "function") {
    const err = new Error("runSoakWithLeakDetection requires runLoadCycle");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (!Number.isFinite(soakMs) || soakMs < 1) {
    const err = new Error("soakMs must be a positive finite number");
    err.failureClass = "validation_failed";
    throw err;
  }
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 1) {
    const err = new Error("sampleIntervalMs must be a positive finite number");
    err.failureClass = "validation_failed";
    throw err;
  }

  const edgeSeries = [];
  const orchSeries = [];
  const loadResults = [];
  const startedAt = nowFn();
  const minSamples = warmupSamples + 2;
  let tick = 0;

  while (true) {
    const atMs = nowFn();
    const edge = await sampleEdge({ nowMs: atMs, tick });
    const orch = await sampleOrchestrator({ nowMs: atMs, tick });
    edgeSeries.push(edge);
    orchSeries.push(orch);

    emitSoakLeakTelemetry({
      outcome: "ok",
      action: "sample",
      tick,
      edgeRssBytes: edge.rssBytes,
      edgeHandleCount: edge.handleCount,
      orchRssBytes: orch.rssBytes,
      orchHandleCount: orch.handleCount,
      orchSource: orch.source ?? null,
      subjectId: null,
      deviceId: opts.deviceId ?? "edge-soak",
    });

    const load = await runLoadCycle({ tick, atMs });
    loadResults.push(load);

    tick += 1;
    const elapsed = nowFn() - startedAt;
    if (elapsed >= soakMs && tick >= minSamples) break;
    if (elapsed >= soakMs && tick < minSamples) {
      // Short CI windows: take the minimum samples needed for leak math.
      await sleepFn(0);
      continue;
    }
    const remaining = soakMs - elapsed;
    await sleepFn(Math.min(sampleIntervalMs, Math.max(remaining, 1)));
  }

  const series = { edge: edgeSeries, orchestrator: orchSeries };
  const leakGate = evaluateSoakLeakGate(series, {
    warmupSamples,
    rssGrowthToleranceBytes: opts.rssGrowthToleranceBytes,
    handleGrowthTolerance: opts.handleGrowthTolerance,
  });

  return {
    soakMs,
    sampleIntervalMs,
    warmupSamples,
    ticks: tick,
    series,
    loadResults,
    leakGate,
    elapsedMs: nowFn() - startedAt,
  };
}
