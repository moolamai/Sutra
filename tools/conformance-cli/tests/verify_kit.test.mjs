/**
 * Independence-kit verify unit tests.
 * Run: node --test tools/conformance-cli/tests/verify_kit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyIndependenceKit } from "../lib/verify-independence-kit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const KIT_DIR = path.join(
  REPO,
  "packages",
  "contract-conformance",
  "fixtures",
  "independence-kit",
);

function scratchKit(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), "indekit-verify-"));
  if (existsSync(KIT_DIR)) {
    cpSync(KIT_DIR, dir, { recursive: true });
  } else {
    mkdirSync(dir, { recursive: true });
  }
  mutate?.(dir);
  return dir;
}

test("known-good extracted kit passes verify", () => {
  assert.ok(existsSync(KIT_DIR), "run package build to generate independence-kit");
  const events = [];
  const result = verifyIndependenceKit(KIT_DIR, {
    subjectId: "cert.kit.good",
    deviceId: "ci",
    emit: (e) => events.push(e),
  });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.manifest?.kitVersion, "1.0.0");
  assert.ok(events.some((e) => e.outcome === "pass" && e.code === "KIT_OK"));
  assert.ok(events.every((e) => e.subjectId === "cert.kit.good"));
});

test("missing fixture directory fails with typed code", () => {
  const dir = scratchKit((root) => {
    rmSync(path.join(root, "sync", "golden-turns"), {
      recursive: true,
      force: true,
    });
  });
  try {
    const result = verifyIndependenceKit(dir, {
      subjectId: "cert.kit.missing",
      deviceId: "ci",
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("golden-turns")));
    assert.equal(result.events.at(-1)?.code, "KIT_INVALID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing cross-subject fixture fails sovereignty check", () => {
  const dir = scratchKit((root) => {
    rmSync(
      path.join(
        root,
        "sync",
        "golden-joins",
        "20-subject-isolation-refused.json",
      ),
      { force: true },
    );
  });
  try {
    const result = verifyIndependenceKit(dir, { subjectId: "cert.kit.iso" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /subject isolation/i.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checklist with embedded raw content body fails sovereignty", () => {
  const dir = scratchKit((root) => {
    writeFileSync(
      path.join(root, "CERTIFICATION-CHECKLIST.md"),
      [
        "# bad",
        "SYNC-01.1 SYNC-01.2 CK-03.1 CK-03.2 CK-03.3 CK-03.L1 CK-03.L2",
        "Harness stream subjectId never",
        'utterance: "please solve this long homework problem about ratios for me now"',
      ].join("\n"),
      "utf8",
    );
  });
  try {
    const result = verifyIndependenceKit(dir, { subjectId: "cert.kit.raw" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /raw content/i.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid kit root fails without hanging", () => {
  const result = verifyIndependenceKit(path.join(tmpdir(), "no-such-indekit-dir"), {
    subjectId: "cert.kit.gone",
  });
  assert.equal(result.ok, false);
  assert.equal(result.events[0]?.code, "KIT_ROOT_INVALID");
});
