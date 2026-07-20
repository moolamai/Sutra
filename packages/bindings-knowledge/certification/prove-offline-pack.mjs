#!/usr/bin/env node
/**
 * CLI: prove offline pack retrieve (CK-09.2) under B1 egress deny.
 */
import { proveOfflinePackRetrieve } from "../dist/pack_offline_proof.js";

const proof = await proveOfflinePackRetrieve({
  subjectId: "subj.pack.offline.cli",
  deviceId: "dev-pack-offline-cli",
});

if (!proof.ok) {
  console.error(
    JSON.stringify({
      event: "bindings_knowledge.offline_pack_retrieve",
      outcome: "fail",
      failures: proof.failures,
      egressAttemptCount: proof.egressAttemptCount,
      ck092Ok: proof.ck092Ok,
      localityOk: proof.localityOk,
    }),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    event: "bindings_knowledge.offline_pack_retrieve",
    outcome: "pass",
    packId: proof.packId,
    locality: proof.locality,
    asOf: proof.asOf,
    passageCount: proof.passageCount,
    egressAttemptCount: proof.egressAttemptCount,
    ck092Ok: proof.ck092Ok,
  }),
);
process.exit(0);

