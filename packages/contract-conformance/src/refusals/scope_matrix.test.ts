/**
 * 002 — profile scope matrix + decline semantics.
 *
 * Happy path: matrix aligns with domains/*; each row completes or declines under
 * CognitiveCore with reference mocks.
 * Edge: concurrent subject-isolated turns; idempotent replay; no charter leak.
 *
 * Run after build: `node --test dist/refusals/scope_matrix.test.js`
 *
 * @module refusals/scope_matrix.test
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { CognitiveCoreTurnEvent } from "@moolam/cognitive-core";
import {
  SCOPE_MATRIX_IN_SCOPE_COMPLETION,
  SCOPE_MATRIX_PROFILE_IDS,
  SCOPE_OF_PRACTICE_MATRIX,
  assertMatrixProfileAlignedWithDomainSpec,
  flattenScopeMatrixCases,
  loadScopeOfPracticeMatrix,
  readDomainInterfacesMd,
  runScopeMatrixCaseTurn,
  scopeMatrixSubjectId,
  type ScopeMatrixEvent,
} from "./scope_matrix.js";

test("happy path: matrix covers teacher, doctor, lawyer with in- and out-of-scope pairs", () => {
  const ids = SCOPE_OF_PRACTICE_MATRIX.map((p) => p.profileId).sort();
  assert.deepEqual(ids, [...SCOPE_MATRIX_PROFILE_IDS].sort());

  for (const profile of SCOPE_OF_PRACTICE_MATRIX) {
    const ins = profile.cases.filter((c) => c.expectancy === "in-scope");
    const outs = profile.cases.filter((c) => c.expectancy === "out-of-scope");
    assert.ok(ins.length >= 1, `${profile.profileId} needs ≥1 in-scope case`);
    assert.ok(outs.length >= 1, `${profile.profileId} needs ≥1 out-of-scope case`);
    assert.ok(profile.refusals.length >= 1);
    assert.ok(profile.charter.length > 0);
    for (const c of outs) {
      assert.ok(
        c.expectedRefusal && profile.refusals.includes(c.expectedRefusal),
        `${c.caseId} expectedRefusal must be a profile refusal`,
      );
      assert.match(c.utterance, /\.out\./);
    }
    for (const c of ins) {
      assert.equal(c.expectedRefusal, null);
      assert.match(c.utterance, /\.in\./);
    }
  }
});

test("happy path: loadScopeOfPracticeMatrix aligns every profile with domains/interfaces.md", () => {
  const events: ScopeMatrixEvent[] = [];
  const loaded = loadScopeOfPracticeMatrix({
    subjectId: "subj-scope-load",
    deviceId: "dev-scope",
    emit: (e) => events.push(e),
  });
  assert.equal(loaded.length, 3);
  assert.ok(events.every((e) => e.outcome === "ok"));
  assert.equal(events.length, 3);
  for (const profile of loaded) {
    assertMatrixProfileAlignedWithDomainSpec(profile);
    const md = readDomainInterfacesMd(profile.profileId);
    assert.match(md, /AgentProfile/);
  }
});

test("happy path: SCOPOFPRAC-002 decline-and-explain vs in-scope completion per matrix row", async () => {
  const rows = flattenScopeMatrixCases();
  assert.ok(rows.length >= 6);
  for (const row of rows) {
    const { output, events, remembered } = await runScopeMatrixCaseTurn(row, {
      deviceId: "dev-scope-turn",
    });
    const turnEvent = events.find(
      (e) => (e as { event?: string }).event === "cognitive_core.turn",
    );
    assert.ok(turnEvent, `missing cognitive_core.turn for ${row.caseId}`);
    assert.equal(turnEvent!.subjectId, scopeMatrixSubjectId(row.profileId, row.caseId));
    assert.equal(turnEvent!.domainId, row.domainId);
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0]!.subjectId, turnEvent!.subjectId);

    if (row.expectancy === "out-of-scope") {
      assert.equal(output.declined, true, row.caseId);
      assert.ok(row.expectedRefusal);
      assert.ok(
        output.refusalCategories.includes(row.expectedRefusal!),
        `${row.caseId} missing refusal category`,
      );
      assert.match(output.reply, /decline|scope of practice/i);
      assert.ok(
        output.reply.includes(row.expectedRefusal!),
        `${row.caseId} decline must name refusal`,
      );
      assert.doesNotMatch(output.reply, new RegExp(escapeRegExp(row.charter.slice(0, 32))));
      assert.doesNotMatch(
        output.reply,
        new RegExp(escapeRegExp(SCOPE_MATRIX_IN_SCOPE_COMPLETION)),
      );
      assert.equal(turnEvent!.outcome, "declined");
      assert.ok(turnEvent!.refusalCategoryCount >= 1);
      assert.match(remembered[0]!.text, /^DECLINE:/);
    } else {
      assert.equal(output.declined, false, row.caseId);
      assert.deepEqual(output.refusalCategories, []);
      assert.equal(output.reply, SCOPE_MATRIX_IN_SCOPE_COMPLETION);
      assert.equal(turnEvent!.outcome, "completed");
      assert.equal(turnEvent!.refusalCategoryCount, 0);
      assert.doesNotMatch(remembered[0]!.text, /^DECLINE:/);
    }
  }
});

test("edge: out-of-scope utterances are probe tokens (no charter leak in probes)", () => {
  for (const row of flattenScopeMatrixCases()) {
    assert.doesNotMatch(row.utterance, /password|ssn|diagnosed patient name/i);
    assert.doesNotMatch(row.utterance, new RegExp(escapeRegExp(row.charter.slice(0, 24))));
    if (row.expectancy === "out-of-scope") {
      assert.ok(row.expectedRefusal);
      assert.ok(row.refusals.includes(row.expectedRefusal!));
    }
  }
});

test("edge: concurrent loads are idempotent and subject-scoped", async () => {
  const [a, b] = await Promise.all([
    Promise.resolve(
      loadScopeOfPracticeMatrix({
        subjectId: "subj-a",
        deviceId: "dev-a",
      }),
    ),
    Promise.resolve(
      loadScopeOfPracticeMatrix({
        subjectId: "subj-b",
        deviceId: "dev-b",
      }),
    ),
  ]);
  assert.equal(a.length, b.length);
  assert.deepEqual(
    a.map((p) => p.domainId),
    b.map((p) => p.domainId),
  );
  const first = flattenScopeMatrixCases(a)[0]!;
  const sidA = scopeMatrixSubjectId(first.profileId, first.caseId);
  const sidB = scopeMatrixSubjectId(
    first.profileId,
    `${first.caseId}.peer`,
  );
  assert.notEqual(sidA, sidB);
  assert.match(sidA, new RegExp(`subj\\.scope\\.${first.profileId}`));
});

test("edge: concurrent composed turns isolate subjects and replay idempotently", async () => {
  const outs = flattenScopeMatrixCases().filter(
    (r) => r.expectancy === "out-of-scope",
  );
  assert.ok(outs.length >= 2);
  const left = outs[0]!;
  const right = outs[1]!;
  const turnEvents: CognitiveCoreTurnEvent[] = [];

  const [a, b, aReplay] = await Promise.all([
    runScopeMatrixCaseTurn(left, {
      subjectId: scopeMatrixSubjectId(left.profileId, left.caseId),
      deviceId: "dev-a",
      emit: (e) => turnEvents.push(e),
    }),
    runScopeMatrixCaseTurn(right, {
      subjectId: scopeMatrixSubjectId(right.profileId, right.caseId),
      deviceId: "dev-b",
      emit: (e) => turnEvents.push(e),
    }),
    runScopeMatrixCaseTurn(left, {
      subjectId: scopeMatrixSubjectId(left.profileId, left.caseId),
      deviceId: "dev-a-replay",
    }),
  ]);

  assert.equal(a.output.declined, true);
  assert.equal(b.output.declined, true);
  assert.equal(aReplay.output.declined, true);
  assert.deepEqual(a.output.refusalCategories, aReplay.output.refusalCategories);
  assert.equal(a.output.reply, aReplay.output.reply);
  assert.notEqual(
    a.remembered[0]!.subjectId,
    b.remembered[0]!.subjectId,
    "cross-subject memory bleed",
  );
  assert.ok(
    turnEvents.every((e) => e.event === "cognitive_core.turn" && e.outcome === "declined"),
  );
});

test("edge: replayed flatten yields identical case ids (idempotent table)", () => {
  const once = flattenScopeMatrixCases().map((c) => c.caseId);
  const twice = flattenScopeMatrixCases().map((c) => c.caseId);
  assert.deepEqual(once, twice);
  assert.equal(new Set(once).size, once.length, "case ids must be unique");
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
