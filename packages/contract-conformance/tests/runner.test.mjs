/**
 * Isolated deadlined runner .
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OBLIGATION_DEADLINE_MS,
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  runConformance,
} from "../dist/index.js";

const MUST_DURABLE = "`remember` MUST be durable before resolving.";
const MUST_SUBJECT_SAFE =
  "Implementations MUST be safe under concurrent subjects (multi-tenant).";

function makeDurability() {
  return defineObligation({
    id: "CK-02.1",
    contract: "MemoryInterface",
    mustText: MUST_DURABLE,
    specIds: ["CK-02"],
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
      const other = `${ctx.subjectId}::peer`;
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

function makeHang() {
  return defineObligation({
    id: "CK-99.hang",
    contract: "HarnessProbe",
    mustText: "A hanging implementation MUST fail at the obligation deadline.",
    specIds: ["CK-01"],
    async check() {
      await new Promise((resolve) => {
        // Intentionally ignore AbortSignal — deadline race must still win.
        // unref so a discarded hang does not keep the test process alive.
        const timer = setTimeout(resolve, 60_000);
        if (typeof timer.unref === "function") timer.unref();
      });
    },
  });
}

function goodFactory() {
  let calls = 0;
  const factory = () => {
    calls += 1;
    const bySubject = new Map();
    return {
      async remember(subjectId, value) {
        bySubject.set(subjectId, value);
        return { durable: true };
      },
      async recall(subjectId) {
        return bySubject.get(subjectId) ?? null;
      },
    };
  };
  factory.calls = () => calls;
  return factory;
}

function leakyFactory() {
  let shared = null;
  return () => ({
    async remember(_subjectId, value) {
      shared = value;
      return { durable: true };
    },
    async recall() {
      return shared;
    },
  });
}

test("default deadline is 5s", () => {
  assert.equal(DEFAULT_OBLIGATION_DEADLINE_MS, 5_000);
});

test("happy path: known-good factory passes selected obligations; exit 0", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeDurability());
  registry.register(makeIsolation());
  const factory = goodFactory();
  const events = [];

  const report = await runConformance({
    registry,
    factory,
    subjectId: "subj-good",
    deviceId: "dev-1",
    obligationIds: ["CK-02.1", "CK-02.3"],
    emit: (e) => events.push(e),
  });

  assert.equal(factory.calls(), 2, "fresh factory per obligation");
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.ok(report.verdicts.every((v) => v.outcome === "pass"));
  assert.ok(report.verdicts.every((v) => v.mustText.includes("MUST")));
  assert.ok(
    events.some((e) => e.event === "conformance.runner" && e.outcome === "pass"),
  );
});

test("seeded violation fails exactly its obligation; suite continues; exit 1", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeDurability());
  registry.register(makeIsolation());

  let n = 0;
  const factory = () => {
    n += 1;
    if (n === 1) {
      return {
        async remember() {
          return { durable: false };
        },
        async recall() {
          return null;
        },
      };
    }
    const bySubject = new Map();
    return {
      async remember(subjectId, value) {
        bySubject.set(subjectId, value);
      },
      async recall(subjectId) {
        return bySubject.get(subjectId) ?? null;
      },
    };
  };

  const report = await runConformance({
    registry,
    factory,
    subjectId: "subj-partial",
    obligationIds: ["CK-02.1", "CK-02.3"],
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.passed, 1);
  assert.equal(report.verdicts[0].obligationId, "CK-02.1");
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.equal(report.verdicts[0].mustText, MUST_DURABLE);
  assert.equal(report.verdicts[1].outcome, "pass");
});

test("edge: hanging check fails at deadline; harness does not hang", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeHang());
  registry.register(makeDurability());

  const started = Date.now();
  const report = await runConformance({
    registry,
    factory: goodFactory(),
    subjectId: "subj-hang",
    obligationIds: ["CK-99.hang", "CK-02.1"],
    deadlineMs: 40,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `harness hung (${elapsed}ms)`);
  assert.equal(report.timedOut, 1);
  assert.equal(report.passed, 1);
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].outcome, "timeout");
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.equal(report.verdicts[1].outcome, "pass");
});

test("edge: async setup error attributed to implementation", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeDurability());

  const report = await runConformance({
    registry,
    factory: async () => {
      throw new Error("factory exploded");
    },
    subjectId: "subj-setup",
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.errored, 1);
  assert.equal(report.verdicts[0].outcome, "error");
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /factory exploded/);
});

test("edge: teardown error attributed to implementation", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeDurability());

  const report = await runConformance({
    registry,
    factory: goodFactory(),
    subjectId: "subj-td",
    teardown: async () => {
      throw new Error("teardown exploded");
    },
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].outcome, "error");
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /teardown exploded/);
});

test("edge: subject-isolation obligation fails leaky factory", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeIsolation());

  const report = await runConformance({
    registry,
    factory: leakyFactory(),
    subjectId: "subj-leak",
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].obligationId, "CK-02.3");
});

test("edge: replay of the same run is idempotent on exit code", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeDurability());
  registry.register(makeIsolation());
  const opts = {
    registry,
    factory: goodFactory(),
    subjectId: "subj-replay",
    obligationIds: ["CK-02.1", "CK-02.3"],
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, a.exitCode);
  assert.deepEqual(
    a.verdicts.map((v) => v.outcome),
    b.verdicts.map((v) => v.outcome),
  );
});

test("edge: unknown selection yields harness-attributed error report", async () => {
  const registry = new ObligationRegistry();
  registry.register(makeDurability());
  const report = await runConformance({
    registry,
    factory: goodFactory(),
    subjectId: "subj-unknown",
    obligationIds: ["CK-nope"],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].attribution, "harness");
  assert.equal(report.verdicts[0].outcome, "error");
});
