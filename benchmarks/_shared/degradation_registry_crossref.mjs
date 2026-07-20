/**
 * Degradation registry ↔ drill cross-reference checker.
 * Verifies machine rows match default-registry.json verbatim and that
 * chaos drill outputs match the locked expected fields.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCloudLlmDownDrill,
  runEdgeSlmFailureDrill,
} from "./degradation_drill_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CROSSREF_JSON = path.join(__dirname, "../chaos/degradation_registry_crossref.json");
const CROSSREF_DOC = path.join(
  REPO_ROOT,
  "docs/protocol/DEGRADATION-DRILL-CROSSREF.md",
);
const REGISTRY_FIXTURE = path.join(
  REPO_ROOT,
  "packages/sync-protocol/fixtures/degradation-registry/default-registry.json",
);

export function loadCrossrefDocument(crossrefPath = CROSSREF_JSON) {
  const raw = JSON.parse(readFileSync(crossrefPath, "utf8"));
  if (!raw?.version || !Array.isArray(raw.rows) || raw.rows.length === 0) {
    return { ok: false, failureClass: "invalid_crossref", detail: "rows required" };
  }
  if (raw.allowsFabrication !== false || raw.allowsSilentWriteRetry !== false) {
    return {
      ok: false,
      failureClass: "fabrication_or_silent_retry",
      detail: "crossref must forbid fabrication and silent write retry",
    };
  }
  return { ok: true, document: raw };
}

export function loadRegistryFixture(registryPath = REGISTRY_FIXTURE) {
  const raw = JSON.parse(readFileSync(registryPath, "utf8"));
  return raw;
}

/**
 * Assert each registry_binding row's mode + signalCode match the fixture
 * byte-for-byte (verbatim).
 */
export function verifyRegistryBindings(crossref, registry) {
  const mismatches = [];
  for (const row of crossref.rows) {
    if (row.verify !== "registry_binding") continue;
    const binding = registry.bindings.find(
      (b) => b.surface === row.surface && b.operation === row.operation,
    );
    if (!binding) {
      mismatches.push({
        id: row.id,
        detail: `no binding for ${row.surface}:${row.operation}`,
      });
      continue;
    }
    if (binding.mode !== row.registryMode) {
      mismatches.push({
        id: row.id,
        detail: `mode want=${row.registryMode} got=${binding.mode}`,
      });
    }
    const modeSpec = registry.modes[row.registryMode];
    if (!modeSpec) {
      mismatches.push({ id: row.id, detail: `unknown mode ${row.registryMode}` });
      continue;
    }
    if (modeSpec.signalCode !== row.signalCode) {
      mismatches.push({
        id: row.id,
        detail: `signalCode want=${row.signalCode} got=${modeSpec.signalCode}`,
      });
    }
    if (modeSpec.requiresFreshnessMarker !== row.requiresFreshnessMarker) {
      mismatches.push({
        id: row.id,
        detail: `requiresFreshnessMarker mismatch`,
      });
    }
    if (modeSpec.allowsFabrication !== false) {
      mismatches.push({ id: row.id, detail: "allowsFabrication must be false" });
    }
    if (modeSpec.allowsSilentWriteRetry !== false) {
      mismatches.push({
        id: row.id,
        detail: "allowsSilentWriteRetry must be false",
      });
    }
  }
  return {
    ok: mismatches.length === 0,
    failureClass: mismatches.length ? "registry_verbatim_mismatch" : null,
    mismatches,
  };
}

/**
 * Assert chaos drill live results match locked expected fields verbatim.
 */
export async function verifyChaosDrillRows(crossref, opts = {}) {
  const mismatches = [];
  const results = [];

  for (const row of crossref.rows) {
    if (row.verify !== "chaos_drill") continue;
    let result;
    if (row.drill === "cloud_llm_down") {
      result = runCloudLlmDownDrill({
        mode: row.drillMode ?? "turn",
        subjectId: opts.subjectId ?? `subj-xref-${row.id}`,
        deviceId: opts.deviceId ?? `edge-xref-${row.id}`,
      });
    } else if (row.drill === "edge_slm_failure") {
      result = await runEdgeSlmFailureDrill({
        mode: row.drillMode ?? "missing",
        subjectId: opts.subjectId ?? `subj-xref-${row.id}`,
        deviceId: opts.deviceId ?? `edge-xref-${row.id}`,
      });
    } else {
      mismatches.push({ id: row.id, detail: `unknown drill ${row.drill}` });
      continue;
    }
    results.push({ id: row.id, result });

    if (!result.ok) {
      mismatches.push({
        id: row.id,
        detail: `drill failed: ${result.failureClass ?? result.detail}`,
      });
      continue;
    }

    for (const [key, want] of Object.entries(row.expected ?? {})) {
      const got = result[key];
      if (got !== want) {
        mismatches.push({
          id: row.id,
          detail: `${key} want=${JSON.stringify(want)} got=${JSON.stringify(got)}`,
        });
      }
    }

    if (row.freshnessSource && result.freshnessSource !== row.freshnessSource) {
      mismatches.push({
        id: row.id,
        detail: `freshnessSource want=${row.freshnessSource} got=${result.freshnessSource}`,
      });
    }
    if (row.failureClass && result.failureClass !== row.failureClass) {
      mismatches.push({
        id: row.id,
        detail: `failureClass want=${row.failureClass} got=${result.failureClass}`,
      });
    }
    if (row.signalCode && row.registryMode === "STALE_READ") {
      // ATR-05 path proves STALE_READ freshness source; signal name is locked
      // in the crossref JSON and must match the registry fixture.
      const modeSpec = loadRegistryFixture().modes[row.registryMode];
      if (modeSpec.signalCode !== row.signalCode) {
        mismatches.push({
          id: row.id,
          detail: `ATR-05 signalCode not verbatim vs registry`,
        });
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    failureClass: mismatches.length ? "chaos_drill_mismatch" : null,
    mismatches,
    results,
  };
}

export function verifyDocAndPaths(crossref) {
  const problems = [];
  if (!existsSync(CROSSREF_DOC)) {
    problems.push({ detail: `missing doc ${CROSSREF_DOC}` });
  } else {
    const doc = readFileSync(CROSSREF_DOC, "utf8");
    for (const needle of [
      "DEGRADE_STALE_READ",
      "DEGRADE_HARD_STOP_WRITE",
      "DEGRADE_QUEUE_AND_WARN",
      "last-known-good",
      "missing_weights",
      "cloud_llm_down",
      "edge_slm_failure",
      "allowsFabrication",
    ]) {
      if (!doc.includes(needle)) {
        problems.push({ detail: `doc missing verbatim token ${needle}` });
      }
    }
  }

  for (const row of crossref.rows) {
    if (!row.drillPath) continue;
    const abs = path.join(REPO_ROOT, row.drillPath);
    if (!existsSync(abs)) {
      problems.push({ id: row.id, detail: `missing drillPath ${row.drillPath}` });
    }
  }

  // Coverage: every default binding must appear once.
  const registry = loadRegistryFixture();
  for (const b of registry.bindings) {
    const hit = crossref.rows.find(
      (r) =>
        r.verify === "registry_binding" &&
        r.surface === b.surface &&
        r.operation === b.operation,
    );
    if (!hit) {
      problems.push({
        detail: `binding ${b.surface}:${b.operation} not covered by crossref`,
      });
    }
  }

  return {
    ok: problems.length === 0,
    failureClass: problems.length ? "doc_or_path" : null,
    mismatches: problems,
  };
}

/**
 * Full gate: registry bindings verbatim + doc tokens + live chaos drills.
 */
export async function runCrossrefGate(opts = {}) {
  const loaded = loadCrossrefDocument(opts.crossrefPath);
  if (!loaded.ok) return loaded;

  const registry = loadRegistryFixture(opts.registryPath);
  const binding = verifyRegistryBindings(loaded.document, registry);
  const docs = verifyDocAndPaths(loaded.document);
  const chaos = opts.skipChaos
    ? { ok: true, mismatches: [], results: [] }
    : await verifyChaosDrillRows(loaded.document, opts);

  const mismatches = [
    ...(binding.mismatches ?? []),
    ...(docs.mismatches ?? []),
    ...(chaos.mismatches ?? []),
  ];
  const ok = binding.ok && docs.ok && chaos.ok;

  process.stdout.write(
    `${JSON.stringify({
      event: "benchmarks.degradation_crossref",
      outcome: ok ? "ok" : "fail",
      subjectId: opts.subjectId ?? null,
      deviceId: opts.deviceId ?? "edge-xref",
      mismatchCount: mismatches.length,
      failureClass: ok
        ? null
        : binding.failureClass || docs.failureClass || chaos.failureClass,
    })}\n`,
  );

  return {
    ok,
    failureClass: ok
      ? null
      : binding.failureClass || docs.failureClass || chaos.failureClass,
    mismatches,
    binding,
    docs,
    chaos,
  };
}

export { CROSSREF_JSON, CROSSREF_DOC, REGISTRY_FIXTURE, REPO_ROOT };
