/**
 * CERTRUN-002 unit tests — findings triage, gate unlock, sovereignty.
 * Run: node --test scripts/prove-certification-freeze-publish.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyCertificationFreezePublish,
  proveSeededBlockerKeepsGateLocked,
} from "./prove-certification-freeze-publish.mjs";
import { parseFreezeAcceptance } from "./check-production-publish-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

test("happy path: certification findings + Accepted RFC + unlocked gate + 1.0.0", () => {
  const result = verifyCertificationFreezePublish({ emit: false });
  assert.equal(result.ok, true);
  assert.equal(result.gate.unlocked, true);
  assert.equal(result.acceptance.accepted, true);
});

test("edge: seeded Blocks acceptance row keeps gate locked (idempotent check)", () => {
  const result = proveSeededBlockerKeepsGateLocked();
  assert.equal(result.ok, true);
});

test("edge: restart survival — re-parse RFC yields same unlock decision", () => {
  const rfc = readFileSync(
    path.join(REPO, "rfcs", "0001-protocol-1.0-freeze.md"),
    "utf8",
  );
  const a = parseFreezeAcceptance(rfc);
  const b = parseFreezeAcceptance(rfc);
  assert.equal(a.unlocked, b.unlocked);
  assert.equal(a.accepted, true);
  assert.equal(a.hasBlockingIssues, false);
});

test("sovereignty: findings JSON and RFC omit raw utterance bodies", () => {
  const findings = readFileSync(
    path.join(REPO, "rfcs", "appendix", "certification-findings.json"),
    "utf8",
  );
  const rfc = readFileSync(
    path.join(REPO, "rfcs", "0001-protocol-1.0-freeze.md"),
    "utf8",
  );
  assert.doesNotMatch(findings, /utterance\s*[:=]\s*["'][^"']{20,}/i);
  assert.doesNotMatch(rfc, /"delta"\s*:\s*"[^"]{40,}"/);
  const parsed = JSON.parse(findings);
  assert.ok(parsed.subjectId);
  assert.ok(parsed.deviceId);
});

test("observability: prove emits metadata-only events", () => {
  const events = [];
  verifyCertificationFreezePublish({
    emit: false,
  });
  // Direct emit path
  const captured = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    verifyCertificationFreezePublish({ emit: undefined });
  } finally {
    process.stdout.write = orig;
  }
  const lines = captured.join("").split(/\n/).filter(Boolean);
  assert.ok(lines.some((l) => l.includes("certification.freeze.prove")));
  assert.ok(lines.every((l) => !/LEARNER_UTTERANCE/.test(l)));
});
