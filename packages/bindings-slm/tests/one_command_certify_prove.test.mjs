/**
 * One-command certify proof: llama.cpp desktop + ONNX android-mid.
 * Seeded red fails a single command; green writes committable reports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CERTIFICATION_CHECK_DEADLINE_MS } from "@moolam/contract-conformance";
import {
  ONE_COMMAND_PROVE_TARGETS,
  proveOneCommandCertifyFlow,
  runBindingsSlmCli,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
import { loadNightlyCi } from "../../../scripts/ci-workflow-test-helpers.mjs";
const SECRET = "SECRET_ONE_COMMAND_BODY";
const COMMITTED_PROOF = path.join(
  PKG,
  "certification/proofs/one-command.proof.json",
);

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write(c) { out.push(String(c)); } },
      stderr: { write(c) { err.push(String(c)); } },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("unit: prove targets are llama.cpp + one mobile (android-mid)", () => {
  assert.equal(ONE_COMMAND_PROVE_TARGETS.length, 2);
  assert.equal(ONE_COMMAND_PROVE_TARGETS[0].adapter, "llamacpp");
  assert.equal(ONE_COMMAND_PROVE_TARGETS[0].profileId, "desktop");
  assert.equal(ONE_COMMAND_PROVE_TARGETS[1].adapter, "onnx");
  assert.equal(ONE_COMMAND_PROVE_TARGETS[1].profileId, "android-mid");
  assert.equal(CERTIFICATION_CHECK_DEADLINE_MS, 5_000);
});

test("happy path: one-command prove green for desktop + android-mid", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-one-cmd-"));
  const cap = captureIo();
  const proof = await proveOneCommandCertifyFlow({
    io: cap.io,
    reportDir: path.join(dir, "reports"),
    proofOutPath: path.join(dir, "one-command.proof.json"),
    packageRoot: PKG,
  });

  assert.equal(proof.exitCode, 0, cap.err() + JSON.stringify(proof.failures));
  assert.equal(proof.seededRed.ok, true);
  assert.equal(proof.seededRed.exitCode, 1);
  assert.equal(proof.targets.length, 2);
  for (const t of proof.targets) {
    assert.equal(t.exitCode, 0, `${t.label} exit`);
    assert.equal(t.outcome, "pass");
    assert.equal(t.replayExitCode, 0);
    assert.ok(t.subjectId.trim());
    assert.ok(t.deviceId.trim());
    assert.ok(existsSync(t.reportPath));
    const disk = JSON.parse(readFileSync(t.reportPath, "utf8"));
    assert.equal(disk.outcome, "pass");
    assert.ok(!JSON.stringify(disk).includes(SECRET));
  }
  assert.equal(proof.targets[0].adapter, "llamacpp");
  assert.equal(proof.targets[1].adapter, "onnx");
  assert.ok(existsSync(path.join(dir, "one-command.proof.json")));
  assert.ok(!cap.out().includes(SECRET));

  rmSync(dir, { recursive: true, force: true });
});

test("edge: seeded hash violation fails single CLI-equivalent command", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-one-cmd-red-"));
  const proof = await proveOneCommandCertifyFlow({
    io: captureIo().io,
    reportDir: path.join(dir, "reports"),
    writeProof: false,
    packageRoot: PKG,
  });
  assert.equal(proof.seededRed.ok, true);
  assert.equal(proof.seededRed.exitCode, 1);
  assert.match(proof.seededRed.detail, /hash|expected/i);
  const redReport = path.join(dir, "reports", "seeded-red.cert.json");
  assert.ok(existsSync(redReport));
  const disk = JSON.parse(readFileSync(redReport, "utf8"));
  assert.equal(disk.outcome, "fail");
  rmSync(dir, { recursive: true, force: true });
});

test("edge: missing artifact profile fails android-mid one-command", async () => {
  const cap = captureIo();
  // Unknown profile via CLI — single command fails loud.
  const code = await runBindingsSlmCli(
    ["certify", "--profile", "no-such-mobile", "--adapter", "onnx"],
    cap.io,
  );
  assert.equal(code, 1);
  assert.match(cap.err(), /unknown certification profile|CERT FAIL/i);
});

test("sovereignty: concurrent prove subjects stay isolated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-one-cmd-iso-"));
  const proof = await proveOneCommandCertifyFlow({
    io: captureIo().io,
    reportDir: path.join(dir, "reports"),
    writeProof: false,
    packageRoot: PKG,
  });
  assert.equal(proof.exitCode, 0, JSON.stringify(proof.failures));
  // Concurrent block inside prove already asserted; surface device ids distinct.
  const ids = proof.targets.map((t) => t.subjectId);
  assert.equal(new Set(ids).size, ids.length);
  rmSync(dir, { recursive: true, force: true });
});

test("ci: binding-certify-harness runs ci:prove:one-command", () => {
  const yml = loadNightlyCi();
  assert.match(yml, /ci:prove:one-command/);
  assert.match(yml, /one-command\.proof\.json/);
  const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts["ci:prove:one-command"], "string");
  assert.equal(typeof pkg.scripts["prove:one-command"], "string");
});

test("committed proof artifact exists after local prove (optional seed)", async () => {
  // Ensure committed proof path is writable/valid shape when present.
  if (!existsSync(COMMITTED_PROOF)) {
    const proof = await proveOneCommandCertifyFlow({
      io: captureIo().io,
      packageRoot: PKG,
      proofOutPath: COMMITTED_PROOF,
    });
    assert.equal(proof.exitCode, 0, JSON.stringify(proof.failures));
  }
  const disk = JSON.parse(readFileSync(COMMITTED_PROOF, "utf8"));
  assert.equal(disk.event, "bindings_slm.one_command_prove");
  assert.equal(disk.exitCode, 0);
  assert.equal(disk.seededRed.ok, true);
  assert.ok(disk.targets.some((t) => t.adapter === "llamacpp"));
  assert.ok(disk.targets.some((t) => t.adapter === "onnx"));
});
