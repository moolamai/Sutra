// Degradation drills — cloud LLM down, edge SLM failure, registry cross-ref.
import {
  runCloudLlmDownDrill,
  runEdgeSlmFailureDrill,
  formatDegradationDrillReport,
} from "../_shared/degradation_drill_probe.mjs";
import { runCrossrefGate } from "../_shared/degradation_registry_crossref.mjs";

process.stdout.write(
  `${JSON.stringify({
    event: "benchmarks.degradation_drill",
    outcome: "start",
    drill: process.env.SUTRA_DEGR_DRILL ?? "all",
    deviceId: "edge-degr",
    subjectId: null,
  })}\n`,
);

const DRILL = (process.env.SUTRA_DEGR_DRILL ?? "all").toLowerCase();

const results = [];

async function main() {
  if (DRILL === "cloud_llm_down" || DRILL === "all") {
    for (const mode of ["turn", "http", "concurrent", "sovereignty"]) {
      const result = runCloudLlmDownDrill({
        mode,
        subjectId: `subj-degr-${mode}`,
        deviceId: `edge-degr-${mode}`,
      });
      results.push({ mode, ...result });
      process.stdout.write(
        `${formatDegradationDrillReport(result)} mode=${mode}\n`,
      );
      if (!result.ok) process.exitCode = 1;
    }
  }

  if (DRILL === "edge_slm_failure" || DRILL === "all") {
    for (const mode of [
      "missing",
      "corrupt",
      "recovery",
      "concurrent",
      "sovereignty",
    ]) {
      const result = await runEdgeSlmFailureDrill({
        mode,
        subjectId: `subj-slm-${mode}`,
        deviceId: `edge-slm-${mode}`,
      });
      results.push({ mode, ...result });
      process.stdout.write(
        `${formatDegradationDrillReport(result)} mode=${mode}\n`,
      );
      if (!result.ok) process.exitCode = 1;
    }
  }

  if (DRILL === "crossref" || DRILL === "all") {
    const gate = await runCrossrefGate({
      subjectId: "subj-degr-crossref",
      deviceId: "edge-degr-crossref",
    });
    results.push({ mode: "crossref", ok: gate.ok, drill: "crossref" });
    process.stdout.write(
      gate.ok
        ? "PASS degradation_registry_crossref\n"
        : `FAIL degradation_registry_crossref ${gate.failureClass}\n`,
    );
    if (!gate.ok) process.exitCode = 1;
  }

  if (
    DRILL !== "cloud_llm_down" &&
    DRILL !== "edge_slm_failure" &&
    DRILL !== "crossref" &&
    DRILL !== "all"
  ) {
    process.stdout.write(
      `${JSON.stringify({
        event: "benchmarks.degradation_drill",
        outcome: "unknown_drill",
        drill: DRILL,
        deviceId: "edge-degr",
        subjectId: null,
      })}\n`,
    );
    process.exitCode = 1;
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `${JSON.stringify({
      event: "benchmarks.degradation_drill",
      outcome: failed.length ? "fail" : "ok",
      drill: DRILL,
      passed: results.length - failed.length,
      failed: failed.length,
      deviceId: "edge-degr",
      subjectId: null,
    })}\n`,
  );

  if (failed.length) process.exit(1);
}

await main();
