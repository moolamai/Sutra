/**
 * CI prove: committed micro-run fixture set loads green;
 * intentionally broken network-model fixture turns red with DIFF;
 * re-checking the good set stays green.
 *
 * Usage:
 *   node training/pipeline/micro_run/prove_fixtures.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MicroRunFixtureError,
  lintMicroRunModelStubFile,
  loadMicroRunFixtureSet,
} from "./load_fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const VIOLATION = path.join(
  FIXTURES,
  "violations",
  "unpinned-network-model.json",
);

try {
  const events = [];
  const loaded = loadMicroRunFixtureSet({
    fixturesDir: FIXTURES,
    onTelemetry: (e) => events.push(e),
  });

  let violationRejected = false;
  /** @type {string|undefined} */
  let violationObligation;
  try {
    lintMicroRunModelStubFile(VIOLATION, {
      subjectId: loaded.subjectId,
      deviceId: loaded.deviceId,
    });
  } catch (err) {
    if (
      err instanceof MicroRunFixtureError &&
      err.obligation === "micro_run.network_forbidden"
    ) {
      violationRejected = true;
      violationObligation = err.obligation;
      process.stdout.write(
        `${JSON.stringify({
          event: "training.micro_run.fixtures.prove",
          outcome: "advisory",
          subjectId: loaded.subjectId,
          deviceId: loaded.deviceId,
          stage: err.stage,
          obligation: err.obligation,
          diff: err.diff,
        })}\n`,
      );
    } else {
      throw err;
    }
  }

  if (!violationRejected) {
    throw new MicroRunFixtureError(
      "expected unpinned-network-model fixture to fail micro_run.network_forbidden",
      {
        stage: "model",
        obligation: "micro_run.set_invalid",
        subjectId: loaded.subjectId,
        deviceId: loaded.deviceId,
      },
    );
  }

  // Revert path: good set still loads.
  loadMicroRunFixtureSet({ fixturesDir: FIXTURES });

  process.stdout.write(
    `${JSON.stringify({
      event: "training.micro_run.fixtures.prove",
      outcome: "ok",
      subjectId: loaded.subjectId,
      deviceId: loaded.deviceId,
      setId: loaded.set.setId,
      baseModelHash: loaded.baseModelHash,
      gymScenarioCount: loaded.taskPins.length,
      violationRejected: true,
      violationObligation,
      telemetryCount: events.length,
    })}\n`,
  );
  process.exit(0);
} catch (err) {
  if (err instanceof MicroRunFixtureError) {
    process.stderr.write(
      `MICRO-RUN FIXTURE PROVE FAIL stage=${err.stage} obligation=${err.obligation}` +
        (err.failingSlice ? ` slice=${err.failingSlice}` : "") +
        `\n${err.message}\n`,
    );
    if (err.diff) process.stderr.write(`DIFF\n${err.diff}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `MICRO-RUN FIXTURE PROVE FAIL ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
