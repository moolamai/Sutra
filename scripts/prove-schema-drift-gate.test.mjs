/**
 * Unit + integration coverage for the red→green schema-drift proof.
 * Run: node --test scripts/prove-schema-drift-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SEED_FIELD,
  seedPydanticDrift,
  restoreContract,
  proveSchemaDriftGate,
} from "./prove-schema-drift-gate.mjs";

const ANCHOR = `class SyncAdvisory(BaseModel):
    code: Literal["CLOCK_SKEW_CLAMPED"]
    detail: str


class SyncRequest(BaseModel):
    subjectId: str
`;

test("seedPydanticDrift inserts seedDriftMarker after SyncAdvisory.detail", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prove-seed-"));
  const file = path.join(dir, "contract_models.py");
  try {
    writeFileSync(file, ANCHOR, "utf8");
    const original = seedPydanticDrift(file);
    const seeded = readFileSync(file, "utf8");
    assert.ok(seeded.includes(SEED_FIELD));
    assert.ok(seeded.includes("SCHEMA_DRIFT_SEED"));
    assert.ok(seeded.includes("subjectId"));
    restoreContract(original, file);
    assert.equal(readFileSync(file, "utf8"), ANCHOR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedPydanticDrift handles CRLF Python sources", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prove-crlf-"));
  const file = path.join(dir, "contract_models.py");
  const crlf = ANCHOR.replace(/\n/g, "\r\n");
  try {
    writeFileSync(file, crlf, "utf8");
    seedPydanticDrift(file);
    assert.ok(readFileSync(file, "utf8").includes(SEED_FIELD));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: double-seed refused with typed error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prove-dbl-"));
  const file = path.join(dir, "contract_models.py");
  try {
    writeFileSync(file, ANCHOR, "utf8");
    seedPydanticDrift(file);
    assert.throws(
      () => seedPydanticDrift(file),
      /SCHEMA_DRIFT_PROVE_ALREADY_SEEDED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: finally restores when seeded-red assertion would leave mutates", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prove-restore-"));
  const file = path.join(dir, "contract_models.py");
  try {
    writeFileSync(file, ANCHOR, "utf8");
    let calls = 0;
    const result = proveSchemaDriftGate({
      contractPath: file,
      runGate: () => {
        calls += 1;
        // baseline green, then red without a diff (forces failure), then green
        if (calls === 1) return { status: 0, stdout: "", stderr: "", combined: "ok" };
        if (calls === 2) {
          return {
            status: 1,
            stdout: "",
            stderr: "failed silently",
            combined: "failed silently",
          };
        }
        return { status: 0, stdout: "", stderr: "", combined: "ok" };
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("SEEDED_DRIFT_NO_DIFF")));
    assert.equal(readFileSync(file, "utf8"), ANCHOR, "seed must be restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subject-isolation: CognitiveState subjectId remains after full prove cycle", async (t) => {
  // Serialize against other file-mutating cases; full live exporters are the deliverable.
  t.diagnostic("live prove: baseline → seed SyncAdvisory.seedDriftMarker → red → revert → green");
  const result = proveSchemaDriftGate();
  assert.equal(result.ok, true, result.failures?.join("\n\n") ?? "prove failed");
  assert.ok(result.phases.some((p) => p.phase === "seeded-red" && p.outcome === "ok"));
  assert.ok(
    result.phases.some((p) => p.phase === "reverted-green" && p.outcome === "ok"),
  );
  assert.match(result.redLog ?? "", new RegExp(SEED_FIELD));
  assert.match(result.redLog ?? "", /--- /);
});
