/**
 * Lockstep bump to Protocol 1.0.0 (CERTRUN-002).
 * Sets npm package versions, PROTOCOL_VERSION, Python orchestrator, and schema consts.
 *
 * Usage: node scripts/bump-protocol-1-0-0.mjs
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const VERSION = "1.0.0";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "protocol.bump_1_0_0", ...event })}\n`,
  );
}

function bumpPackageJson(pkgDir) {
  const pj = path.join(pkgDir, "package.json");
  if (!existsSync(pj)) return false;
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  if (!String(pkg.name ?? "").startsWith("@moolam/")) return false;
  if (pkg.private === true) return false;
  pkg.version = VERSION;
  writeFileSync(pj, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg.name;
}

function replaceInFile(rel, patterns) {
  const abs = path.join(REPO, rel);
  let text = readFileSync(abs, "utf8");
  for (const [re, rep] of patterns) {
    text = text.replace(re, rep);
  }
  writeFileSync(abs, text);
}

function main() {
  const subjectId = "release-1.0.0";
  const deviceId = "ci";
  emit({ outcome: "start", subjectId, deviceId, version: VERSION });

  const bumped = [];
  for (const entry of readdirSync(path.join(REPO, "packages"))) {
    const name = bumpPackageJson(path.join(REPO, "packages", entry));
    if (name) bumped.push(name);
  }

  replaceInFile("packages/sync-protocol/src/contract.ts", [
    [/export const PROTOCOL_VERSION = "[^"]+"/, `export const PROTOCOL_VERSION = "${VERSION}"`],
  ]);
  replaceInFile("packages/cloud-orchestrator/pyproject.toml", [
    [/^version = "[^"]+"/m, `version = "${VERSION}"`],
  ]);
  replaceInFile(
    "packages/cloud-orchestrator/src/sutra_orchestrator/__init__.py",
    [
      [/__version__ = "[^"]+"/, `__version__ = "${VERSION}"`],
      [/PROTOCOL_VERSION = "[^"]+"/, `PROTOCOL_VERSION = "${VERSION}"`],
    ],
  );

  // Schema consts — SyncRequest / CognitiveState protocolVersion.
  for (const schema of ["SyncRequest.json", "CognitiveState.json", "SyncResponse.json"]) {
    const rel = path.join("packages", "sync-protocol", "schemas", schema);
    if (!existsSync(path.join(REPO, rel))) continue;
    replaceInFile(rel, [
      [/"const":\s*"0\.1\.0"/g, `"const": "${VERSION}"`],
      [/"x-protocol-version":\s*"0\.1\.0"/g, `"x-protocol-version": "${VERSION}"`],
    ]);
  }

  // Golden envelopes / wire-parity protocolVersion fields.
  const golden = path.join(
    "packages",
    "sync-protocol",
    "fixtures",
    "wire-parity",
    "golden-envelopes.json",
  );
  if (existsSync(path.join(REPO, golden))) {
    replaceInFile(golden, [[/"protocolVersion":\s*"0\.1\.0"/g, `"protocolVersion": "${VERSION}"`]]);
    // Also normalize any 1.0.0 already present stays; ensure schema match.
    replaceInFile(golden, [[/"protocolVersion":\s*"1\.0\.0"/g, `"protocolVersion": "${VERSION}"`]]);
  }

  replaceInFile("docs/protocol/VERSION-LOCKSTEP.md", [
    [
      /\| `export const PROTOCOL_VERSION` \| `[^`]+` \|/,
      `| \`export const PROTOCOL_VERSION\` | \`${VERSION}\` |`,
    ],
    [
      /\| `"version"` \| `[^`]+` \|/,
      `| \`"version"\` | \`${VERSION}\` |`,
    ],
    [
      /\| `\[project\] version` \| `[^`]+` \|/,
      `| \`[project] version\` | \`${VERSION}\` |`,
    ],
    [
      /\| `__version__` \| `[^`]+` \|/,
      `| \`__version__\` | \`${VERSION}\` |`,
    ],
    [
      /\| `PROTOCOL_VERSION` \| `[^`]+` \|/,
      `| \`PROTOCOL_VERSION\` | \`${VERSION}\` |`,
    ],
  ]);

  emit({
    outcome: "packages_bumped",
    subjectId,
    deviceId,
    count: bumped.length,
    packages: bumped,
  });

  // Regenerate wire fixtures + independence kit from updated schemas/goldens.
  const build = spawnSync(
    "pnpm",
    ["--filter", "@moolam/contract-conformance", "run", "build"],
    { cwd: REPO, shell: true, encoding: "utf8", stdio: "inherit" },
  );
  if (build.status !== 0) {
    emit({ outcome: "fail", subjectId, deviceId, phase: "fixtures" });
    process.exitCode = 1;
    return;
  }

  emit({ outcome: "ok", subjectId, deviceId, version: VERSION });
}

main();
