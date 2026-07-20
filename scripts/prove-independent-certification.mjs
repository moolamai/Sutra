/**
 * Prove independent certification: known-good green, then seeded red for
 * SYNC-01.2, then green again. Emits metadata-only events.
 *
 * Usage: node scripts/prove-independent-certification.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIndependentCertification } from "../artifacts/independent-certification/scripts/run-certification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const base = mkdtempSync(path.join(tmpdir(), "prove-indep-cert-"));
  try {
    const green1 = await runIndependentCertification({
      seedMode: "good",
      subjectId: "prove.indep.green1",
      deviceId: "prove-ci",
      dataDir: path.join(base, "g1"),
      emit: (e) =>
        process.stdout.write(`${JSON.stringify({ phase: "green1", ...e })}\n`),
    });
    if (green1.artifact.exitCode !== 0) {
      throw new Error("expected first green pass");
    }

    const red = await runIndependentCertification({
      seedMode: "cross-subject-sync",
      subjectId: "prove.indep.red",
      deviceId: "prove-ci",
      dataDir: path.join(base, "red"),
      emit: (e) =>
        process.stdout.write(`${JSON.stringify({ phase: "red", ...e })}\n`),
    });
    if (red.artifact.exitCode === 0) {
      throw new Error("expected seeded SYNC-01.2 red");
    }
    const iso = red.artifact.verdicts.find((v) => v.obligationId === "SYNC-01.2");
    if (iso?.outcome !== "fail") {
      throw new Error("seeded red must fail SYNC-01.2");
    }

    const green2 = await runIndependentCertification({
      seedMode: "good",
      subjectId: "prove.indep.green2",
      deviceId: "prove-ci",
      dataDir: path.join(base, "g2"),
      emit: (e) =>
        process.stdout.write(`${JSON.stringify({ phase: "green2", ...e })}\n`),
    });
    if (green2.artifact.exitCode !== 0) {
      throw new Error("expected second green pass");
    }

    process.stdout.write("prove-independent-certification: OK (green → red → green)\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
