/**
 * Independence kit: fixtures tarball + checklist + offline pack prove.
 * Run via package test script after build.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runConformance,
  ObligationRegistry,
  defineObligation,
  ObligationViolation,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(__dirname, "..");
const KIT_DIR = path.join(PKG, "fixtures", "independence-kit");
const KIT_TGZ = path.join(PKG, "fixtures", "independence-kit.tgz");
const VERIFY_URL = pathToFileURL(
  path.join(
    PKG,
    "..",
    "..",
    "tools",
    "conformance-cli",
    "lib",
    "verify-independence-kit.mjs",
  ),
).href;

const PACK_TGZ_RE = /^moolam-contract-conformance-.*\.tgz$/i;

function runOk(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function tarExtract(tgz, dest) {
  runOk("tar", ["-xzf", tgz, "-C", dest], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolve the package tarball (ignore fixtures/independence-kit.tgz listed in pack output). */
function findPackageTarball(packDir) {
  const match = readdirSync(packDir).find((n) => PACK_TGZ_RE.test(n));
  return match ? path.join(packDir, match) : null;
}

async function loadVerify() {
  return import(VERIFY_URL);
}

test("independence-kit directory and tarball exist after build", () => {
  assert.ok(existsSync(KIT_DIR), "fixtures/independence-kit missing — run build");
  assert.ok(existsSync(KIT_TGZ), "fixtures/independence-kit.tgz missing — run build");
  assert.ok(existsSync(path.join(KIT_DIR, "CERTIFICATION-CHECKLIST.md")));
  assert.ok(existsSync(path.join(KIT_DIR, "MANIFEST.json")));
  assert.ok(existsSync(path.join(KIT_DIR, "wire", "bundle.json")));
});

test("extracted tarball verifies without reading monorepo sync-protocol", async () => {
  const { verifyIndependenceKit } = await loadVerify();
  const work = mkdtempSync(path.join(tmpdir(), "indekit-extract-"));
  try {
    const extractRoot = path.join(work, "kit");
    mkdirSync(extractRoot, { recursive: true });
    tarExtract(KIT_TGZ, extractRoot);
    const result = verifyIndependenceKit(extractRoot, {
      subjectId: "cert.offline.extract",
      deviceId: "scratch",
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.deepEqual(result.manifest.obligations.sync, [
      "SYNC-01.1",
      "SYNC-01.2",
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("pnpm-packed package ships kit; verify works from pack tree only", async () => {
  const { verifyIndependenceKit } = await loadVerify();
  const work = mkdtempSync(path.join(tmpdir(), "indekit-pack-"));
  try {
    runOk("pnpm", ["pack", "--pack-destination", work], {
      cwd: PKG,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packTgz = findPackageTarball(work);
    assert.ok(packTgz && existsSync(packTgz), `package tarball missing in ${work}`);

    const unpack = path.join(work, "unpacked");
    mkdirSync(unpack, { recursive: true });
    tarExtract(packTgz, unpack);
    const pkgRoot = path.join(unpack, "package");
    assert.ok(
      existsSync(path.join(pkgRoot, "fixtures", "independence-kit.tgz")),
    );
    assert.ok(existsSync(path.join(pkgRoot, "bin", "conformance.mjs")));

    const kitExtract = path.join(work, "kit-from-pack");
    mkdirSync(kitExtract, { recursive: true });
    tarExtract(
      path.join(pkgRoot, "fixtures", "independence-kit.tgz"),
      kitExtract,
    );

    const result = verifyIndependenceKit(kitExtract, {
      subjectId: "cert.offline.pack",
      deviceId: "scratch",
    });
    assert.equal(result.ok, true, result.errors.join("; "));

    assert.match(
      readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
      /"name":\s*"@moolam\/contract-conformance"/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("known-good mock passes kit-covered sync obligations; seeded hang times out", async () => {
  const bundle = JSON.parse(
    readFileSync(path.join(KIT_DIR, "wire", "bundle.json"), "utf8"),
  );
  const registry = new ObligationRegistry();
  registry.register(
    defineObligation({
      id: "SYNC-01.1",
      contract: "SyncRequest",
      mustText:
        "Every implementation-produced SyncRequest MUST validate against the frozen SyncRequest JSON Schema (SYNC-01).",
      specIds: ["SYNC-01"],
      async check(impl) {
        const payload = await impl.produce();
        if (!payload?.protocolVersion) {
          throw new ObligationViolation({
            obligationId: "SYNC-01.1",
            mustText: "MUST validate",
            contract: "SyncRequest",
            message: "missing protocolVersion",
          });
        }
      },
    }),
  );
  registry.register(
    defineObligation({
      id: "KIT-HANG",
      contract: "SyncRequest",
      mustText: "Hang probe MUST fail with deadline.",
      specIds: ["SYNC-01"],
      async check() {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          if (typeof timer.unref === "function") timer.unref();
        });
      },
    }),
  );

  const good = await runConformance({
    registry,
    factory: async () => ({
      produce: async () => structuredClone(bundle.valid),
    }),
    obligationIds: ["SYNC-01.1"],
    subjectId: "cert.kit.sync",
    deviceId: "scratch",
    deadlineMs: 2000,
  });
  assert.equal(good.exitCode, 0);
  assert.equal(good.verdicts[0].outcome, "pass");

  const hung = await runConformance({
    registry,
    factory: async () => ({ produce: async () => bundle.valid }),
    obligationIds: ["KIT-HANG"],
    subjectId: "cert.kit.hang",
    deviceId: "scratch",
    deadlineMs: 50,
  });
  assert.equal(hung.exitCode, 1);
  assert.equal(hung.verdicts[0].outcome, "timeout");
  assert.equal(hung.verdicts[0].obligationId, "KIT-HANG");
});

test("seeded subject-isolation fixture is present and distinct from valid wire", () => {
  const iso = path.join(
    KIT_DIR,
    "sync",
    "golden-joins",
    "20-subject-isolation-refused.json",
  );
  assert.ok(existsSync(iso));
  const doc = JSON.parse(readFileSync(iso, "utf8"));
  assert.equal(doc.id, "20-subject-isolation-refused");
  assert.equal(doc.kind, "subject-isolation");
  assert.equal(doc.expectError, "SUBJECT_MISMATCH");
  assert.notEqual(doc.stateA.subjectId, doc.stateB.subjectId);
});
