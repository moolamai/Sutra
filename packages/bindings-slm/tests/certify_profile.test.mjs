/**
 * Desktop certification profile + bindings-slm certify harness entry.
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS,
  MODEL_OBLIGATION_IDS,
} from "@moolam/contract-conformance";
import {
  CERT_PROFILE_SCHEMA_VERSION,
  CertifyValidationError,
  DESKTOP_PROFILE_PATH,
  LLAMA_CPP_PINNED_REVISION,
  loadCertProfile,
  parseBindingsSlmArgv,
  resolveProfilePath,
  runBindingsSlmCli,
  runCertifyProfile,
  sha256File,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const SECRET = "SECRET_CERT_PROMPT_MUST_NOT_LEAK";

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write(chunk) { out.push(String(chunk)); } },
      stderr: { write(chunk) { err.push(String(chunk)); } },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("happy path: desktop profile loads; hashes pin; certify green", async () => {
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  assert.equal(profile.schemaVersion, CERT_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.profileId, "desktop");
  assert.equal(profile.adapter, "llamacpp");
  assert.equal(profile.hardware.gpuRequired, false);
  assert.deepEqual(
    [...profile.obligations.b0Model].sort(),
    [...DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS].sort(),
  );
  assert.ok(profile.benches.subset.includes("core_loop"));
  assert.ok(profile.benches.subset.includes("first_token"));
  assert.equal(
    profile.modelArtifact.llamaCppPinnedRevision,
    LLAMA_CPP_PINNED_REVISION,
  );

  const fixture = path.join(PKG_ROOT, profile.modelArtifact.fixtureRelpath);
  assert.equal(
    sha256File(fixture),
    profile.modelArtifact.artifactSha256.toLowerCase(),
  );

  const cap = captureIo();
  const { exitCode, report } = await runCertifyProfile(profile, cap.io);
  assert.equal(exitCode, 0, cap.err() + cap.out());
  assert.equal(report.outcome, "pass");
  assert.equal(report.subjectId, profile.subjectId);
  assert.equal(report.deviceId, profile.deviceId);
  assert.equal(report.measuredArtifactSha256, profile.modelArtifact.artifactSha256);
  assert.equal(report.locality.ok, true);
  assert.equal(report.locality.egressAttempts, 0);
  assert.equal(report.obligationVerdicts.length, 3);
  assert.ok(report.obligationVerdicts.every((v) => v.outcome === "pass"));
  assert.equal(report.benches.firstTokenOk, true);
  assert.ok(!cap.out().includes(SECRET));
  assert.ok(!cap.err().includes(SECRET));
  assert.match(cap.out(), /"event":"bindings_slm.certify"/);
});

test("happy path: CLI certify --profile desktop --adapter llamacpp", async () => {
  const cap = captureIo();
  const code = await runBindingsSlmCli(
    ["certify", "--profile", "desktop", "--adapter", "llamacpp"],
    cap.io,
  );
  assert.equal(code, 0, cap.err());
  assert.match(cap.out(), /"outcome":"pass"/);
});

test("edge: unknown profile → exit 1 with named DIFF", async () => {
  const cap = captureIo();
  const code = await runBindingsSlmCli(
    ["certify", "--profile", "no-such-profile"],
    cap.io,
  );
  assert.equal(code, 1);
  assert.match(cap.err(), /CERT FAIL:.*unknown certification profile/i);
});

test("edge: broken artifact hash turns certify red with mismatch DIFF", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cert-bad-"));
  const base = JSON.parse(readFileSync(DESKTOP_PROFILE_PATH, "utf8"));
  const fixtureSrc = path.join(PKG_ROOT, base.modelArtifact.fixtureRelpath);
  const fixtureDst = path.join(dir, "desktop-minimal.gguf");
  copyFileSync(fixtureSrc, fixtureDst);

  const broken = {
    ...base,
    profileId: "desktop-broken-hash",
    modelArtifact: {
      ...base.modelArtifact,
      fixtureRelpath: "desktop-minimal.gguf",
      artifactSha256: "0".repeat(64),
    },
  };
  const profilePath = path.join(dir, "desktop-broken-hash.profile.json");
  writeFileSync(profilePath, JSON.stringify(broken, null, 2));

  // Point PACKAGE_ROOT-relative fixture by rewriting fixtureRelpath absolute via tmp profile load tricks:
  // loadCertProfile then override by running from a synthetic profile with absolute hash miss using package fixture.
  const profile = loadCertProfile(DESKTOP_PROFILE_PATH);
  profile.modelArtifact.artifactSha256 = "0".repeat(64);

  const cap = captureIo();
  const { exitCode, report } = await runCertifyProfile(profile, cap.io);
  assert.equal(exitCode, 1);
  assert.equal(report.outcome, "fail");
  assert.ok(
    report.failures.some((f) => /artifact hash mismatch/i.test(f)),
    report.failures.join("\n"),
  );
  assert.match(cap.err(), /artifact hash mismatch/i);

  rmSync(dir, { recursive: true, force: true });
  void profilePath;
  void fixtureDst;
});

test("edge: adapter mismatch → red", async () => {
  const cap = captureIo();
  const code = await runBindingsSlmCli(
    ["certify", "--profile", "desktop", "--adapter", "onnx"],
    cap.io,
  );
  assert.equal(code, 1);
  assert.match(cap.err(), /does not match profile\.adapter/);
});

test("sovereignty: profile requires subjectId/deviceId; parse argv", () => {
  const args = parseBindingsSlmArgv([
    "certify",
    "--profile",
    "desktop",
    "--adapter",
    "llamacpp",
  ]);
  assert.equal(args.command, "certify");
  assert.equal(args.profile, "desktop");
  assert.equal(resolveProfilePath("desktop"), DESKTOP_PROFILE_PATH);

  assert.throws(
    () => resolveProfilePath("missing-profile-xyz"),
    (err) => err instanceof CertifyValidationError,
  );

  assert.equal(
    MODEL_OBLIGATION_IDS.streamDeltas,
    DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS[1],
  );
});

test("edge: intentionally empty b0Model fails load validation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cert-empty-"));
  const base = JSON.parse(readFileSync(DESKTOP_PROFILE_PATH, "utf8"));
  base.obligations.b0Model = [];
  const p = path.join(dir, "bad.profile.json");
  writeFileSync(p, JSON.stringify(base));
  assert.throws(
    () => loadCertProfile(p),
    (err) => {
      assert.ok(err instanceof CertifyValidationError);
      assert.match(err.message, /b0Model/);
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});
