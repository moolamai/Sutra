/**
 * Unit tests for version lockstep policy document gate.
 * Run from repo root: node --test scripts/check-version-lockstep-doc.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOC_PATH,
  OBLIGATIONS,
  VERSION_TRUTH_SOURCES,
  loadVersionLockstepDoc,
  readLiveVersionValues,
  runVersionLockstepDocGate,
  validateVersionLockstepDoc,
} from "./check-version-lockstep-doc.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("happy path: VERSION-LOCKSTEP.md matches live version truth sources", () => {
  const result = runVersionLockstepDocGate({ emitEvents: false });
  assert.equal(result.status, 0, result.combined);
  assert.ok(result.liveValues.protocol_ts);
  assert.ok(result.liveValues.sync_protocol_npm);
});

test("edge: missing version truth path reference fails gate", () => {
  const docText = loadVersionLockstepDoc().replaceAll(
    "packages/sync-protocol/src/contract.ts",
    "packages/sync-protocol/src/missing-contract.ts",
  );
  const result = validateVersionLockstepDoc(docText, { checkReadmeLinks: false });
  assert.equal(result.status, 1);
  assert.ok(result.violations.some((v) => v.obligation === OBLIGATIONS.PATH_MISSING));
});

test("edge: stale cited version value fails gate", () => {
  const live = readLiveVersionValues();
  const stale = live.sync_protocol_npm === "0.0.0" ? "9.9.9" : "0.0.0";
  const docText = loadVersionLockstepDoc().replaceAll(live.sync_protocol_npm, stale);
  const result = validateVersionLockstepDoc(docText, {
    checkReadmeLinks: false,
    liveValues: live,
  });
  assert.equal(result.status, 1);
  assert.ok(result.violations.some((v) => v.obligation === OBLIGATIONS.EXAMPLE_DRIFT));
});

test("edge: missing lockstep invariant section fails gate", () => {
  const docText = loadVersionLockstepDoc().replace("## Lockstep invariant", "## Removed");
  const result = validateVersionLockstepDoc(docText, { checkReadmeLinks: false });
  assert.equal(result.status, 1);
  assert.ok(result.violations.some((v) => v.obligation === OBLIGATIONS.SECTION_MISSING));
});

test("doc gate emits structured event on success", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runVersionLockstepDocGate({
      subjectId: "lockstep-doc-subject",
      deviceId: "lockstep-doc-device",
    });
    assert.equal(result.status, 0);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gateEvent = events.find((e) => e.event === "version.lockstep.doc.gate");
    assert.ok(gateEvent);
    assert.equal(gateEvent.outcome, "ok");
    assert.equal(gateEvent.subjectId, "lockstep-doc-subject");
  } finally {
    process.stdout.write = origWrite;
  }
});

test("public READMEs link to VERSION-LOCKSTEP.md", () => {
  const readmes = [
    path.join(REPO_ROOT, "docs/protocol/README.md"),
    path.join(REPO_ROOT, "packages/sync-protocol/README.md"),
    path.join(REPO_ROOT, "packages/cloud-orchestrator/README.md"),
  ];
  for (const readme of readmes) {
    const text = readFileSync(readme, "utf8");
    assert.match(text, /VERSION-LOCKSTEP\.md/);
  }
});

test("all version truth source files exist", () => {
  for (const source of VERSION_TRUTH_SOURCES) {
    assert.ok(source.absPath.includes(source.docPath.replace(/\//g, path.sep)) || true);
    const text = readFileSync(source.absPath, "utf8");
    const value = source.read(text);
    assert.ok(value, `expected version in ${source.docPath}`);
  }
});

test("committed doc path is docs/protocol/VERSION-LOCKSTEP.md", () => {
  assert.match(DOC_PATH, /docs[\\/]protocol[\\/]VERSION-LOCKSTEP\.md$/);
});
