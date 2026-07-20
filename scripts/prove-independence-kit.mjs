/**
 * Offline prove: pack @moolam/contract-conformance, extract kit in a scratch
 * directory that has no monorepo checkout, and verify fixtures + checklist.
 *
 * Usage (repo root):
 *   node scripts/prove-independence-kit.mjs
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PKG = path.join(REPO, "packages", "contract-conformance");
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

function findPackageTarball(packDir) {
  const match = readdirSync(packDir).find((n) => PACK_TGZ_RE.test(n));
  return match ? path.join(packDir, match) : null;
}

async function main() {
  runOk("pnpm", ["run", "build"], { cwd: PKG, stdio: "inherit" });

  const work = mkdtempSync(path.join(tmpdir(), "sutra-indekit-prove-"));
  try {
    runOk("pnpm", ["pack", "--pack-destination", work], {
      cwd: PKG,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packTgz = findPackageTarball(work);
    if (!packTgz) {
      throw new Error(
        `pnpm pack produced no moolam-contract-conformance-*.tgz in ${work}`,
      );
    }

    const unpack = path.join(work, "unpacked");
    mkdirSync(unpack, { recursive: true });
    runOk("tar", ["-xzf", packTgz, "-C", unpack], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pkgRoot = path.join(unpack, "package");
    const kitTgz = path.join(pkgRoot, "fixtures", "independence-kit.tgz");
    if (!existsSync(kitTgz)) {
      throw new Error("packed package missing fixtures/independence-kit.tgz");
    }

    const alienHome = path.join(work, "alien-home");
    mkdirSync(alienHome, { recursive: true });
    const kitExtract = path.join(alienHome, "kit");
    mkdirSync(kitExtract, { recursive: true });
    runOk("tar", ["-xzf", kitTgz, "-C", kitExtract], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const verifyMod = await import(
      pathToFileURL(
        path.join(REPO, "tools", "conformance-cli", "lib", "verify-independence-kit.mjs"),
      ).href
    );
    const result = verifyMod.verifyIndependenceKit(kitExtract, {
      subjectId: "prove.offline",
      deviceId: "scratch",
      emit: (e) => {
        process.stdout.write(
          `${JSON.stringify({ event: e.event, outcome: e.outcome, subjectId: e.subjectId, deviceId: e.deviceId, code: e.code })}\n`,
        );
      },
    });

    if (!result.ok) {
      throw new Error(`kit verify failed: ${result.errors.join("; ")}`);
    }

    const checklist = readFileSync(
      path.join(kitExtract, "CERTIFICATION-CHECKLIST.md"),
      "utf8",
    );
    for (const marker of ["SYNC-01.1", "CK-03.1", "CK-03.L1", "Harness stream"]) {
      if (!checklist.includes(marker)) {
        throw new Error(`checklist missing ${marker}`);
      }
    }

    process.stdout.write("prove-independence-kit: OK (pack → extract → verify)\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
