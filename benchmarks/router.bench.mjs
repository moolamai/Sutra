// Task-router overhead (NFR-04): assess_friction → route decision only.
// Excludes LLM / model generation. Uses the demo prerequisite graph with a
// remediation depth breaker so cyclic DAGs cannot spin unbounded.
import { bench, BENCH_SUBJECT_ID } from "./_shared/bench.mjs";
import {
  mockFrictionNominal,
  mockFrictionSpike,
  mockMasteryStrong,
  mockMasteryWeakPrereq,
  routeTurn,
} from "./_shared/router_probe.mjs";

const DEVICE_ID = "bench-harness";

await bench(
  "task-router assess→route (nominal)",
  () =>
    routeTurn({
      subjectId: BENCH_SUBJECT_ID,
      activeConceptId: "math.ratios",
      mode: "exploratory",
      friction: mockFrictionNominal(),
      mastery: mockMasteryStrong(),
    }),
  { warmup: 50, iterations: 500, subjectId: BENCH_SUBJECT_ID, deviceId: DEVICE_ID },
);

await bench(
  "task-router assess→route (remediate depth-breaker)",
  () =>
    routeTurn({
      subjectId: BENCH_SUBJECT_ID,
      activeConceptId: "math.ratios",
      mode: "exploratory",
      friction: mockFrictionSpike(),
      mastery: mockMasteryWeakPrereq(),
    }),
  { warmup: 50, iterations: 500, subjectId: BENCH_SUBJECT_ID, deviceId: DEVICE_ID },
);
