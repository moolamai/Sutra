/**
 * Bundle independence-kit wire fixtures + certification checklist.
 *
 * Copies P0/P6 sync-protocol fixtures and the generated wire bundle into
 * fixtures/independence-kit/, then packs fixtures/independence-kit.tgz so the
 * published @moolam/contract-conformance package installs without a monorepo.
 *
 * Usage (from package root, after fixtures:wire):
 *   node scripts/bundle-independence-kit.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(__dirname, "..");
const REPO = path.join(PKG, "..", "..");
const SYNC_FIXTURES = path.join(REPO, "packages", "sync-protocol", "fixtures");
const CHECKLIST_SRC = path.join(
  REPO,
  "docs",
  "protocol",
  "CERTIFICATION-CHECKLIST.md",
);
const WIRE_BUNDLE = path.join(PKG, "fixtures", "wire", "bundle.json");
const OUT_DIR = path.join(PKG, "fixtures", "independence-kit");
const OUT_TGZ = path.join(PKG, "fixtures", "independence-kit.tgz");

/** Fixture trees shipped for sync / harness / tool / degradation surfaces. */
const SYNC_DIRS = [
  "wire-parity",
  "golden-joins",
  "golden-turns",
  "tool-envelope",
  "advisories",
  "degradation-registry",
];

export const KIT_VERSION = "1.0.0";

export const OBLIGATION_COVERAGE = Object.freeze({
  sync: ["SYNC-01.1", "SYNC-01.2"],
  harness: [
    "harness-frames",
    "golden-turns",
    "tool-envelope",
    "degradation-registry",
  ],
  binding: ["CK-03.1", "CK-03.2", "CK-03.3"],
  locality: ["CK-03.L1", "CK-03.L2"],
});

function requirePath(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`independence-kit bundle missing ${label}: ${filePath}`);
  }
}

function copyTree(src, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/**
 * Build the unpacked kit directory and tarball. Returns the MANIFEST object.
 */
export function bundleIndependenceKit(options = {}) {
  const outDir = options.outDir ?? OUT_DIR;
  const outTgz = options.outTgz ?? OUT_TGZ;
  const syncFixtures = options.syncFixtures ?? SYNC_FIXTURES;
  const checklistSrc = options.checklistSrc ?? CHECKLIST_SRC;
  const wireBundle = options.wireBundle ?? WIRE_BUNDLE;

  requirePath(wireBundle, "wire bundle");
  requirePath(checklistSrc, "CERTIFICATION-CHECKLIST.md");
  for (const dir of SYNC_DIRS) {
    requirePath(path.join(syncFixtures, dir), `sync fixture ${dir}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(outDir, "sync"), { recursive: true });
  mkdirSync(path.join(outDir, "wire"), { recursive: true });

  for (const dir of SYNC_DIRS) {
    copyTree(path.join(syncFixtures, dir), path.join(outDir, "sync", dir));
  }
  cpSync(wireBundle, path.join(outDir, "wire", "bundle.json"));
  cpSync(checklistSrc, path.join(outDir, "CERTIFICATION-CHECKLIST.md"));

  const manifest = {
    schemaVersion: "independence-kit.manifest.v1",
    kitVersion: KIT_VERSION,
    note: "GENERATED — do not hand-edit. Source: sync-protocol fixtures + wire bundle + CERTIFICATION-CHECKLIST.",
    obligations: OBLIGATION_COVERAGE,
    contents: {
      checklist: "CERTIFICATION-CHECKLIST.md",
      wire: ["wire/bundle.json"],
      sync: SYNC_DIRS.map((d) => `sync/${d}/`),
    },
    sovereignty: {
      subjectScoped: true,
      noRawContentInReports: true,
      crossSubjectFixture: "sync/golden-joins/20-subject-isolation-refused.json",
    },
  };
  writeFileSync(
    path.join(outDir, "MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  if (existsSync(outTgz)) {
    rmSync(outTgz, { force: true });
  }
  // Pack contents of outDir as archive root (checklist at tarball root).
  execFileSync(
    "tar",
    ["-czf", outTgz, "-C", outDir, "."],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  if (!existsSync(outTgz)) {
    throw new Error(`failed to write fixtures tarball: ${outTgz}`);
  }

  return { manifest, outDir, outTgz };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const result = bundleIndependenceKit();
  const size = readFileSync(result.outTgz).byteLength;
  process.stdout.write(
    `independence-kit: wrote ${result.outDir} and ${result.outTgz} (${size} bytes)\n`,
  );
}
