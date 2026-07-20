/**
 * Obligation registry types + ID discipline .
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DuplicateObligationIdError,
  ObligationRegistry,
  ObligationViolation,
  UnknownObligationIdError,
  createObligationContext,
  defineObligation,
  invokeObligation,
} from "../dist/index.js";

/** Verbatim from packages/contracts/src/memory.ts contract comment. */
const MUST_DURABLE = "`remember` MUST be durable before resolving.";

const MUST_SUBJECT_SAFE =
  "Implementations MUST be safe under concurrent subjects (multi-tenant).";

const MUST_PROBE =
  "Probe MUST surface unexpected errors as ObligationViolation.";

function goodMock() {
  const bySubject = new Map();
  return {
    async remember(subjectId, value) {
      bySubject.set(subjectId, value);
      return { subjectId, value, durable: true };
    },
    async recall(subjectId) {
      return bySubject.get(subjectId) ?? null;
    },
  };
}

function leakyMock() {
  let only = null;
  return {
    async remember(_subjectId, value) {
      only = value;
      return { durable: true };
    },
    async recall(_subjectId) {
      return only;
    },
  };
}

function makeDurability() {
  return defineObligation({
    id: "CK-02.1",
    contract: "MemoryInterface",
    mustText: MUST_DURABLE,
    specIds: ["CK-02", "MCE-03"],
    async check(impl, ctx) {
      await impl.remember(ctx.subjectId, "token-a");
      const got = await impl.recall(ctx.subjectId);
      if (got !== "token-a") {
        throw new ObligationViolation({
          obligationId: "CK-02.1",
          mustText: MUST_DURABLE,
          contract: "MemoryInterface",
          message: "remember did not persist before resolve",
        });
      }
    },
  });
}

function makeIsolation() {
  return defineObligation({
    id: "CK-02.3",
    contract: "MemoryInterface",
    mustText: MUST_SUBJECT_SAFE,
    specIds: ["CK-02"],
    async check(impl, ctx) {
      const other = `${ctx.subjectId}-other`;
      await impl.remember(ctx.subjectId, "mine");
      await impl.remember(other, "theirs");
      if ((await impl.recall(ctx.subjectId)) !== "mine") {
        throw new ObligationViolation({
          obligationId: "CK-02.3",
          mustText: MUST_SUBJECT_SAFE,
          contract: "MemoryInterface",
          message: "subject-scoped recall lost own write",
        });
      }
      if ((await impl.recall(other)) !== "theirs") {
        throw new ObligationViolation({
          obligationId: "CK-02.3",
          mustText: MUST_SUBJECT_SAFE,
          contract: "MemoryInterface",
          message: "cross-subject store leak or overwrite",
        });
      }
    },
  });
}

function makeReasoningProbe() {
  return defineObligation({
    id: "CK-04.1",
    contract: "ReasoningInterface",
    mustText: "Reasoning traces MUST be non-empty when a constraint applies.",
    specIds: ["CK-04"],
    async check() {},
  });
}

function seededRegistry(emit) {
  const registry = new ObligationRegistry({ emit });
  registry.register(makeDurability());
  registry.register(makeIsolation());
  registry.register(makeReasoningProbe());
  return registry;
}

test("happy path: known-good mock passes all selected registry obligations", async () => {
  const events = [];
  const registry = seededRegistry((e) => events.push(e));
  const impl = goodMock();
  const selected = registry.select(["CK-02.1", "CK-02.3"]);
  for (const obl of selected) {
    const ctx = createObligationContext({
      subjectId: "subj-good",
      deviceId: "dev-test",
      deadlineMs: 1_000,
      emit: (e) => events.push(e),
    });
    await invokeObligation(obl, impl, ctx);
  }
  assert.equal(registry.size, 3);
  assert.ok(events.some((e) => e.event === "conformance.registry" && e.outcome === "registered"));
  assert.equal(
    events.filter((e) => e.event === "conformance.obligation" && e.outcome === "pass")
      .length,
    2,
  );
});

test("seeded violation fails exactly its obligation via registry.select", async () => {
  const registry = seededRegistry();
  const [durability] = registry.select(["CK-02.1"]);
  const events = [];
  const impl = {
    async remember() {
      return { durable: false };
    },
    async recall() {
      return null;
    },
  };
  const ctx = createObligationContext({
    subjectId: "subj-bad",
    emit: (e) => events.push(e),
  });
  await assert.rejects(
    () => invokeObligation(durability, impl, ctx),
    (err) =>
      err instanceof ObligationViolation &&
      err.obligationId === "CK-02.1" &&
      err.mustText === MUST_DURABLE,
  );
  assert.equal(events.at(-1)?.outcome, "fail");
  assert.equal(events.at(-1)?.obligationId, "CK-02.1");
});

test("edge: subject-isolation obligation fails leaky mock", async () => {
  const registry = seededRegistry();
  const [isolation] = registry.select(["CK-02.3"]);
  const ctx = createObligationContext({ subjectId: "subj-a" });
  await assert.rejects(
    () => invokeObligation(isolation, leakyMock(), ctx),
    (err) => err instanceof ObligationViolation && err.obligationId === "CK-02.3",
  );
});

test("edge: duplicate obligation id is rejected (append-only)", () => {
  const events = [];
  const registry = new ObligationRegistry({ emit: (e) => events.push(e) });
  registry.register(makeDurability());
  assert.throws(
    () => registry.register(makeDurability()),
    (err) =>
      err instanceof DuplicateObligationIdError && err.obligationId === "CK-02.1",
  );
  assert.ok(
    events.some(
      (e) => e.outcome === "duplicate_rejected" && e.obligationId === "CK-02.1",
    ),
  );
  assert.equal(registry.size, 1, "duplicate must not enlarge the registry");
});

test("edge: replaying the same registration after success stays rejected", () => {
  const registry = seededRegistry();
  assert.throws(() => registry.register(makeIsolation()), DuplicateObligationIdError);
  assert.deepEqual([...registry.listIds()], ["CK-02.1", "CK-02.3", "CK-04.1"]);
});

test("groupByContract buckets and sorts catalog entries", () => {
  const registry = seededRegistry();
  const grouped = registry.groupByContract();
  assert.deepEqual([...grouped.keys()], ["MemoryInterface", "ReasoningInterface"]);
  assert.deepEqual(
    grouped.get("MemoryInterface").map((e) => e.id),
    ["CK-02.1", "CK-02.3"],
  );
  assert.equal(grouped.get("ReasoningInterface").length, 1);
});

test("exportCatalogJson is stable metadata for sync_audit violation classes", () => {
  const registry = seededRegistry();
  const json = registry.exportCatalogJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, "obligation-catalog");
  assert.equal(parsed.catalogVersion, "1.0.0");
  assert.equal(parsed.obligations.length, 3);
  for (const row of parsed.obligations) {
    assert.equal(row.violationClass, row.id);
    assert.ok(row.mustText.includes("MUST"));
    assert.ok(!("check" in row));
  }
  assert.deepEqual(registry.violationClasses(), ["CK-02.1", "CK-02.3", "CK-04.1"]);
  // Second export byte-identical (docs / M-point consumers).
  assert.equal(registry.exportCatalogJson(), json);
});

test("edge: unknown selection id is a typed failure", () => {
  const events = [];
  const registry = new ObligationRegistry({ emit: (e) => events.push(e) });
  registry.register(makeDurability());
  assert.throws(
    () => registry.select(["CK-02.1", "CK-99.9"]),
    (err) =>
      err instanceof UnknownObligationIdError && err.obligationId === "CK-99.9",
  );
  assert.ok(
    events.some(
      (e) => e.outcome === "unknown_selection" && e.obligationId === "CK-99.9",
    ),
  );
});

test("edge: missing subjectId is rejected at context creation", () => {
  assert.throws(
    () => createObligationContext({ subjectId: "   " }),
    /subjectId/,
  );
});

test("edge: empty mustText / missing MUST rejected by defineObligation", () => {
  assert.throws(
    () =>
      defineObligation({
        id: "CK-00.0",
        contract: "X",
        mustText: "  ",
        specIds: ["CK-00"],
        async check() {},
      }),
    /mustText/,
  );
  assert.throws(
    () =>
      defineObligation({
        id: "CK-00.1",
        contract: "X",
        mustText: "remember should be durable before resolving.",
        specIds: ["CK-00"],
        async check() {},
      }),
    /MUST/,
  );
});

test("edge: async setup error attributed as ObligationViolation", async () => {
  const boom = defineObligation({
    id: "CK-99.9",
    contract: "HarnessProbe",
    mustText: MUST_PROBE,
    specIds: ["CK-01"],
    async check() {
      throw new Error("setup exploded");
    },
  });
  const ctx = createObligationContext({ subjectId: "subj-err" });
  await assert.rejects(
    () => invokeObligation(boom, {}, ctx),
    (err) =>
      err instanceof ObligationViolation &&
      err.obligationId === "CK-99.9" &&
      /setup exploded/.test(err.message),
  );
});

test("context carries positive deadlineMs for runner deadline enforcement", () => {
  const ctx = createObligationContext({
    subjectId: "subj-deadline",
    deadlineMs: 250,
  });
  assert.equal(ctx.deadlineMs, 250);
  assert.ok(ctx.signal);
});
