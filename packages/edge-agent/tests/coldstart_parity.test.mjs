/**
 * CAST-05 cold-start parity — edge harness (coldstart.ts) vs shared goldens.
 * Full route nextConceptId/mode is covered by playground + Python; this suite
 * asserts the edge gate agrees on block/allow + probe targets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAST_05_1_OBLIGATION_ID,
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  evaluateColdStartParityGate,
  listUnassessedRoots,
  masteryEvidenceCounts,
  rootConceptIdsFromNodes,
} from "../dist/coldstart.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKS = path.join(
  __dirname,
  "..",
  "..",
  "domain-loader",
  "fixtures",
  "packs",
);
const TEACHER_PACK = path.join(PACKS, "teacher-cbse-slice.json");
const GOLDENS = path.join(PACKS, "teacher-cbse-slice.coldstart-goldens.json");

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function rootsFromTeacherPack() {
  const raw = loadJson(TEACHER_PACK);
  const prereq = new Map(raw.concepts.map((c) => [c.conceptId, []]));
  for (const e of raw.edges) {
    if (e.type !== "prerequisite") continue;
    const list = prereq.get(e.fromConceptId);
    if (list) list.push(e.toConceptId);
  }
  return rootConceptIdsFromNodes(
    raw.concepts.map((c) => ({
      conceptId: c.conceptId,
      prerequisites: prereq.get(c.conceptId) ?? [],
    })),
  );
}

function rootsFromCase(caseRow, teacherRoots) {
  if (caseRow.inlineGraph) {
    return rootConceptIdsFromNodes(caseRow.inlineGraph.nodes);
  }
  return teacherRoots;
}

function masteryShards(caseRow, deviceId) {
  const mastery = {};
  for (const [cid, ab] of Object.entries(caseRow.mastery ?? {})) {
    mastery[cid] = {
      alpha: { [deviceId]: ab.alpha },
      beta: { [deviceId]: ab.beta },
    };
  }
  return mastery;
}

test("unit: shared coldstart goldens next to teacher pack", () => {
  assert.ok(existsSync(TEACHER_PACK));
  assert.ok(existsSync(GOLDENS));
  const goldens = loadJson(GOLDENS);
  assert.equal(goldens.schemaVersion, "teacher-cbse-slice.coldstart-goldens.v1");
  assert.equal(goldens.packFile, path.basename(TEACHER_PACK));
});

test("parity: edge coldstart gate matches golden block/probe fields", () => {
  const goldens = loadJson(GOLDENS);
  const teacherRoots = rootsFromTeacherPack();
  const deviceId = goldens.deviceId;
  assert.ok(teacherRoots.includes("math.fractions"));

  for (const c of goldens.cases) {
    const events = [];
    const roots = rootsFromCase(c, teacherRoots);
    const mastery = masteryShards(c, deviceId);
    const counts = masteryEvidenceCounts(mastery);
    const unassessed = listUnassessedRoots(roots, counts);
    assert.deepEqual(
      unassessed,
      c.expect.unassessedRoots,
      `${c.id} unassessedRoots`,
    );

    const wouldAdvance =
      c.expect.gateBlocked === true ||
      c.expect.mode === "exploratory";
    const gate = evaluateColdStartParityGate({
      subjectId: c.subjectId,
      deviceId,
      mode: c.mode,
      wouldAdvance,
      rootConceptIds: roots,
      mastery,
      emit: (e) => events.push(e),
    });

    assert.equal(gate.blocked, c.expect.gateBlocked, `${c.id} gateBlocked`);
    if (c.expect.gateBlocked) {
      assert.equal(gate.probeConceptId, c.expect.probeConceptId, `${c.id} probe`);
      assert.equal(gate.mode, "diagnostic");
      assert.ok(gate.rationaleAdvisory?.includes(CAST_05_1_OBLIGATION_ID));
      assert.ok(
        events.some(
          (e) =>
            e.event === "coldstart.gate" &&
            e.outcome === "block_advance" &&
            e.subjectId === c.subjectId &&
            e.deviceId === deviceId &&
            e.obligationId === CAST_05_1_OBLIGATION_ID,
        ),
        `${c.id} missing block_advance event`,
      );
    } else {
      assert.equal(gate.probeConceptId, null);
      assert.ok(
        events.some((e) => e.outcome === "allow_advance"),
        `${c.id} missing allow_advance`,
      );
    }

    // Idempotent replay of the gate evaluation.
    const again = evaluateColdStartParityGate({
      subjectId: c.subjectId,
      deviceId,
      mode: c.mode,
      wouldAdvance,
      rootConceptIds: roots,
      mastery,
    });
    assert.equal(again.blocked, gate.blocked);
    assert.equal(again.probeConceptId, gate.probeConceptId);
  }
});

test("edge: partial assessment — only unassessed roots listed", () => {
  const goldens = loadJson(GOLDENS);
  const partial = goldens.cases.find((c) => c.id === "partial-two-root-inline");
  assert.ok(partial);
  const roots = rootConceptIdsFromNodes(partial.inlineGraph.nodes);
  const mastery = masteryShards(partial, goldens.deviceId);
  const unassessed = listUnassessedRoots(
    roots,
    masteryEvidenceCounts(mastery),
    CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  );
  assert.deepEqual(unassessed, ["root.b"]);
});

test("sovereignty: distinct subjectIds; no cross-subject mastery bleed", () => {
  const goldens = loadJson(GOLDENS);
  const ids = goldens.cases.map((c) => c.subjectId);
  assert.equal(new Set(ids).size, ids.length);
  const a = goldens.cases[0];
  const b = goldens.cases[1];
  const gateA = evaluateColdStartParityGate({
    subjectId: a.subjectId,
    mode: a.mode,
    wouldAdvance: true,
    rootConceptIds: rootsFromTeacherPack(),
    mastery: masteryShards(a, goldens.deviceId),
  });
  const gateB = evaluateColdStartParityGate({
    subjectId: b.subjectId,
    mode: b.mode,
    wouldAdvance: true,
    rootConceptIds: rootsFromTeacherPack(),
    mastery: masteryShards(b, goldens.deviceId),
  });
  assert.equal(gateA.blocked, a.expect.gateBlocked);
  assert.equal(gateB.blocked, b.expect.gateBlocked);
});
