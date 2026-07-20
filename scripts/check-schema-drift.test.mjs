/**
 * Unit tests for the schema-drift gate helpers.
 * Run from repo root: node --test scripts/check-schema-drift.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WIRE_TYPES,
  toDriftCanon,
  sortKeysDeep,
  unifyDiff,
  diffSchemaMaps,
  checkSchemaDrift,
} from "./check-schema-drift.mjs";
import { diffLines } from "./_diff_lines.mjs";

test("diffLines emits -/+ lines for a mismatch (never silent)", () => {
  const lines = diffLines("a\nb\n", "a\nc\n");
  assert.ok(lines.some((l) => l.startsWith("-b")));
  assert.ok(lines.some((l) => l.startsWith("+c")));
});

test("unifyDiff returns empty string when identical", () => {
  assert.equal(unifyDiff("a", "same\n", "b", "same\n"), "");
});

test("toDriftCanon strips Zod propertyNames and uuid pattern noise", () => {
  const zodish = {
    title: "ConceptMastery",
    "x-protocol-version": "1.0.0",
    type: "object",
    properties: {
      alpha: {
        type: "object",
        additionalProperties: { type: "number", minimum: 0 },
        propertyNames: { type: "string" },
      },
      syncAttemptId: {
        type: "string",
        format: "uuid",
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-",
      },
    },
  };
  const pyish = {
    title: "ConceptMastery",
    "x-protocol-version": "1.0.0",
    type: "object",
    properties: {
      alpha: {
        type: "object",
        additionalProperties: { type: "number", minimum: 0 },
      },
      syncAttemptId: {
        type: "string",
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      },
    },
  };
  assert.deepEqual(toDriftCanon(zodish), toDriftCanon(pyish));
});

test("toDriftCanon strips Pydantic optional default:null vs Zod omit", () => {
  const zodish = {
    title: "SyncRequest",
    "x-protocol-version": "0.1.0",
    type: "object",
    properties: {
      headers: {
        type: "object",
        properties: {
          traceparent: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
  };
  const pyish = {
    title: "SyncRequest",
    "x-protocol-version": "0.1.0",
    type: "object",
    properties: {
      headers: {
        type: "object",
        default: null,
        properties: {
          traceparent: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            default: null,
          },
        },
      },
    },
  };
  assert.deepEqual(toDriftCanon(zodish), toDriftCanon(pyish));
});

test("diffSchemaMaps prints unified diff on shape mismatch", () => {
  const left = new Map([["SyncAdvisory", { type: "object", title: "SyncAdvisory", properties: { code: { type: "string" } }, required: ["code"], "x-protocol-version": "1.0.0" }]]);
  const right = new Map([["SyncAdvisory", { type: "object", title: "SyncAdvisory", properties: { code: { type: "string" }, detail: { type: "string" } }, required: ["code", "detail"], "x-protocol-version": "1.0.0" }]]);
  // Pad maps with stubs for other types so helper iterates — only SyncAdvisory differs meaningfully.
  for (const t of WIRE_TYPES) {
    if (!left.has(t)) {
      const stub = { type: "object", title: t, "x-protocol-version": "1.0.0" };
      left.set(t, stub);
      right.set(t, structuredClone(stub));
    }
  }
  const diffs = diffSchemaMaps(left, right, "canon", "left", "right");
  assert.ok(diffs.length >= 1);
  assert.match(diffs.join("\n"), /detail/);
  assert.match(diffs.join("\n"), /^--- /m);
  assert.match(diffs.join("\n"), /^\+\+\+ /m);
});

test("happy path: live exporters agree with committed schemas", () => {
  const result = checkSchemaDrift();
  assert.equal(result.ok, true, result.failures.join("\n\n"));
});

test("edge: missing wire file is reported with typed message", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-drift-missing-"));
  try {
    const ts = path.join(dir, "ts");
    const py = path.join(dir, "py");
    mkdirSync(ts);
    mkdirSync(py);
    const result = checkSchemaDrift({
      tsCommitted: ts,
      pyCommitted: py,
      exportFn: (tempRoot) => {
        const zodOut = path.join(tempRoot, "zod");
        const pyOut = path.join(tempRoot, "py");
        mkdirSync(zodOut);
        mkdirSync(pyOut);
        for (const t of WIRE_TYPES) {
          const body = JSON.stringify({
            title: t,
            type: "object",
            "x-protocol-version": "1.0.0",
          });
          writeFileSync(path.join(zodOut, `${t}.json`), body);
          writeFileSync(path.join(pyOut, `${t}.json`), body);
        }
        return { zodOut, pyOut };
      },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes("SCHEMA_DRIFT_MISSING_FILE")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: stale commit prints unified diff (never bare boolean)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-drift-stale-"));
  try {
    const ts = path.join(dir, "ts");
    const py = path.join(dir, "py");
    mkdirSync(ts);
    mkdirSync(py);
    for (const t of WIRE_TYPES) {
      const committed = JSON.stringify(
        {
          title: t,
          type: "object",
          "x-protocol-version": "1.0.0",
          properties: { legacy: { type: "string" } },
        },
        null,
        2,
      );
      writeFileSync(path.join(ts, `${t}.json`), `${committed}\n`);
      writeFileSync(path.join(py, `${t}.json`), `${committed}\n`);
    }
    const result = checkSchemaDrift({
      tsCommitted: ts,
      pyCommitted: py,
      exportFn: (tempRoot) => {
        const zodOut = path.join(tempRoot, "zod");
        const pyOut = path.join(tempRoot, "py");
        mkdirSync(zodOut);
        mkdirSync(pyOut);
        for (const t of WIRE_TYPES) {
          const fresh = JSON.stringify(
            {
              title: t,
              type: "object",
              "x-protocol-version": "1.0.0",
              properties: { current: { type: "string" } },
            },
            null,
            2,
          );
          writeFileSync(path.join(zodOut, `${t}.json`), `${fresh}\n`);
          writeFileSync(path.join(pyOut, `${t}.json`), `${fresh}\n`);
        }
        return { zodOut, pyOut };
      },
    });
    assert.equal(result.ok, false);
    const blob = result.failures.join("\n");
    assert.match(blob, /STALE/);
    assert.match(blob, /^--- /m);
    assert.match(blob, /^\+\+\+ /m);
    assert.match(blob, /legacy/);
    assert.match(blob, /current/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subject-isolation: CognitiveState required subjectId survives drift-canon", () => {
  const doc = toDriftCanon({
    title: "CognitiveState",
    "x-protocol-version": "1.0.0",
    type: "object",
    required: ["subjectId", "mode"],
    properties: {
      subjectId: { type: "string", minLength: 1, title: "Subjectid" },
      mode: { type: "string" },
    },
  });
  assert.ok(doc.required.includes("subjectId"));
  assert.equal(doc.properties.subjectId.title, undefined);
});

test("sortKeysDeep is deterministic", () => {
  const once = JSON.stringify(sortKeysDeep({ z: 1, a: { d: 2, b: 3 } }));
  const twice = JSON.stringify(sortKeysDeep({ z: 1, a: { d: 2, b: 3 } }));
  assert.equal(once, twice);
});
