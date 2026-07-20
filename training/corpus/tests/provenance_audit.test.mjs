/**
 * Provenance audit fixtures prove (unknown license / consent mix / stable hash).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LICENSE_LEDGER_PACKAGE_ROOT,
  PROVENANCE_AUDIT_ACCEPTED_FIXTURE,
  PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE,
  PROVENANCE_AUDIT_FIXTURE_DIR,
  PROVENANCE_AUDIT_STABLE_HASH_FIXTURE,
  PROVENANCE_AUDIT_UNKNOWN_LICENSE_FIXTURE,
  loadLicenseLedgerDocument,
  parseLicenseLedgerDocument,
  proveProvenanceAudit,
  runProveProvenanceAuditCli,
} from "../dist/license_ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(PKG_ROOT, PROVENANCE_AUDIT_FIXTURE_DIR);
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("unit: committed provenance audit fixtures exist", () => {
  assert.equal(LICENSE_LEDGER_PACKAGE_ROOT, PKG_ROOT);
  for (const name of [
    PROVENANCE_AUDIT_ACCEPTED_FIXTURE,
    PROVENANCE_AUDIT_UNKNOWN_LICENSE_FIXTURE,
    PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE,
    PROVENANCE_AUDIT_STABLE_HASH_FIXTURE,
  ]) {
    assert.ok(existsSync(path.join(AUDIT_DIR, name)), name);
  }
});

test("happy path: proveProvenanceAudit — accepted + negatives + stable hash", () => {
  const events = [];
  const result = proveProvenanceAudit({
    packageRoot: PKG_ROOT,
    subjectId: "subj.corpus.audit.ok",
    deviceId: "dev-audit",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.acceptedEntryCount >= 1);
  assert.equal(result.unknownLicenseExcluded, true);
  assert.equal(result.consentMixBlocked, true);
  assert.equal(result.ledgerHashStable, true);
  assert.match(result.ledgerContentHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(events.some((e) => e.op === "audit" && e.outcome === "ok"));
  assert.ok(events.every((e) => e.subjectId === "subj.corpus.audit.ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: unknown-license audit fixture is excluded (license)", () => {
  const result = loadLicenseLedgerDocument(
    path.join(AUDIT_DIR, PROVENANCE_AUDIT_UNKNOWN_LICENSE_FIXTURE),
    { subjectId: "subj.corpus.audit.unk", deviceId: "dev-audit" },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "license");
});

test("edge: consented vs public mix fixture is blocked (consent)", () => {
  const events = [];
  const result = loadLicenseLedgerDocument(
    path.join(AUDIT_DIR, PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE),
    {
      subjectId: "subj.corpus.audit.mix",
      deviceId: "dev-audit",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "consent");
  assert.match(result.message, /consented vs public mix blocked/i);
  assert.ok(
    events.some(
      (e) =>
        e.op === "validate" &&
        e.outcome === "error" &&
        e.failureClass === "consent",
    ),
  );
});

test("sovereignty: accepted audit ledger is homogeneous consent; no raw content", () => {
  const accepted = loadLicenseLedgerDocument(
    path.join(AUDIT_DIR, PROVENANCE_AUDIT_ACCEPTED_FIXTURE),
    { subjectId: "subj.corpus.audit.iso", deviceId: "dev-audit-iso" },
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  const classes = new Set(accepted.value.entries.map((e) => e.consentClass));
  assert.equal(classes.size, 1);
  assert.ok(!JSON.stringify(accepted.value).includes(SECRET));
});

test("scalability / idempotency: prove is read-only and reentrant", () => {
  const first = proveProvenanceAudit({ packageRoot: PKG_ROOT });
  const second = proveProvenanceAudit({ packageRoot: PKG_ROOT });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.ledgerContentHash, second.ledgerContentHash);
  // Fixtures unchanged on disk after prove.
  const mix = JSON.parse(
    readFileSync(
      path.join(AUDIT_DIR, PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE),
      "utf8",
    ),
  );
  assert.equal(mix.entries.length, 2);
});

test("CLI: prove-provenance exits 0", () => {
  const out = [];
  const err = [];
  const code = runProveProvenanceAuditCli([], {
    stdout: { write(s) { out.push(s); } },
    stderr: { write(s) { err.push(s); } },
  });
  assert.equal(code, 0, err.join(""));
  assert.match(out.join(""), /"outcome":"ok"/);
  assert.match(out.join(""), /"ledgerHashStable":true/);
});

test("edge: parseLicenseLedgerDocument blocks consent mix without file I/O", () => {
  const raw = JSON.parse(
    readFileSync(
      path.join(AUDIT_DIR, PROVENANCE_AUDIT_CONSENT_MIX_FIXTURE),
      "utf8",
    ),
  );
  const result = parseLicenseLedgerDocument(raw);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "consent");
});
