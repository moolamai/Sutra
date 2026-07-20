#!/usr/bin/env node
/**
 * CLI: prove teacher CBSE slice pack wired into CognitiveCore.
 */
import { proveTeacherPackCognitiveCore } from "../dist/pack_example_wiring.js";

const proof = await proveTeacherPackCognitiveCore({
  subjectId: "subj.teacher.pack.cli",
  deviceId: "dev-teacher-pack-cli",
  nowMs: Date.parse("2026-07-15T00:00:00.000Z"),
});

if (!proof.ok) {
  console.error(
    JSON.stringify({
      event: "bindings_knowledge.teacher_pack_wiring",
      outcome: "fail",
      failures: proof.failures,
      egressAttemptCount: proof.egressAttemptCount,
    }),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    event: "bindings_knowledge.teacher_pack_wiring",
    outcome: "pass",
    packId: proof.packId,
    locality: proof.locality,
    asOf: proof.asOf,
    citationCount: proof.citationCount,
    egressAttemptCount: proof.egressAttemptCount,
    domainsImportFree: proof.domainsImportFree,
  }),
);
process.exit(0);

