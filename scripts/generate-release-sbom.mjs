/**
 * Generate CycloneDX 1.5 JSON SBOMs for a Sutra release (SEC-02).
 *
 * Produces:
 *   artifacts/sbom/npm-workspace.cdx.json  — publishable @moolam/* packages
 *   artifacts/sbom/sutra-sdk-python.cdx.json — Python cloud-orchestrator (PyPI sutra-sdk)
 *
 * Never embeds learner content — package names and versions only.
 *
 * Usage (repo root):
 *   node scripts/generate-release-sbom.mjs
 *   pnpm sbom:generate
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPublishableNpmPackageName } from "./check-changeset-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const SBOM_OUT_DIR = path.join(REPO_ROOT, "artifacts", "sbom");
export const SBOM_DOCS_DIR = path.join(REPO_ROOT, "security", "SBOM");

export const OBLIGATIONS = Object.freeze({
  MISSING_PACKAGES_DIR: "sbom.generate.missing_packages_dir",
  NO_COMPONENTS: "sbom.generate.no_components",
  WRITE_FAILED: "sbom.generate.write_failed",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "sbom.generate", ...event })}\n`,
  );
}

/**
 * @param {string} name
 * @param {string} version
 * @param {'npm'|'pypi'} eco
 */
export function purl(name, version, eco) {
  if (eco === "npm") {
    if (name.startsWith("@")) {
      const [scope, pkg] = name.slice(1).split("/");
      return `pkg:npm/%40${scope}/${pkg}@${encodeURIComponent(version)}`;
    }
    return `pkg:npm/${name}@${encodeURIComponent(version)}`;
  }
  return `pkg:pypi/${name}@${encodeURIComponent(version)}`;
}

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   type?: string,
 *   components: { name: string, version: string, eco: 'npm'|'pypi' }[],
 * }} opts
 */
export function buildCycloneDxBom(opts) {
  const timestamp = new Date().toISOString();
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${cryptoRandomUuid()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [
        {
          vendor: "moolam",
          name: "generate-release-sbom",
          version: "0.1.0",
        },
      ],
      component: {
        type: opts.type ?? "application",
        name: opts.name,
        version: opts.version,
      },
    },
    components: opts.components.map((c) => ({
      type: "library",
      name: c.name,
      version: c.version,
      purl: purl(c.name, c.version, c.eco),
      bomRef: purl(c.name, c.version, c.eco),
    })),
  };
}

/** Deterministic-enough UUID without importing crypto for older Node. */
function cryptoRandomUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * List publishable @moolam/* packages (private !== true).
 * @param {string} [packagesDir]
 */
export function listPublishableNpmPackages(packagesDir = path.join(REPO_ROOT, "packages")) {
  if (!existsSync(packagesDir)) {
    throw new Error(`${OBLIGATIONS.MISSING_PACKAGES_DIR}:${packagesDir}`);
  }
  /** @type {{ name: string, version: string, eco: 'npm' }[]} */
  const components = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.private === true) continue;
    if (typeof pkg.name !== "string" || !isPublishableNpmPackageName(pkg.name)) continue;
    if (typeof pkg.version !== "string") continue;
    components.push({ name: pkg.name, version: pkg.version, eco: "npm" });
  }
  components.sort((a, b) => a.name.localeCompare(b.name));
  return components;
}

/**
 * Parse direct runtime deps from cloud-orchestrator pyproject.toml.
 * @param {string} [pyprojectPath]
 */
export function listPythonDirectDeps(
  pyprojectPath = path.join(
    REPO_ROOT,
    "packages",
    "cloud-orchestrator",
    "pyproject.toml",
  ),
) {
  if (!existsSync(pyprojectPath)) return [];
  const text = readFileSync(pyprojectPath, "utf8");
  // Walk lines inside the [project] dependencies = [ ... ] array. Do not use
  // a non-greedy [\s\S]*?\] — extras like uvicorn[standard] contain ']'.
  const lines = text.split(/\r?\n/);
  /** @type {{ name: string, version: string, eco: 'pypi' }[]} */
  const components = [];
  let inProject = false;
  let inDeps = false;
  for (const line of lines) {
    if (/^\[project\]\s*$/.test(line)) {
      inProject = true;
      inDeps = false;
      continue;
    }
    if (/^\[/.test(line)) {
      inProject = false;
      inDeps = false;
      continue;
    }
    if (!inProject) continue;
    if (/^\s*dependencies\s*=\s*\[/.test(line)) {
      inDeps = true;
      continue;
    }
    if (inDeps) {
      if (/^\s*\]\s*$/.test(line)) {
        inDeps = false;
        continue;
      }
      const m =
        /"([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(>=|==|~=|<=)?([^"]*)"/.exec(line);
      if (!m) continue;
      const name = m[1].toLowerCase();
      const version =
        (m[3] || "unspecified").replace(/^[<>=~!]+\s*/, "") || "unspecified";
      components.push({ name, version, eco: "pypi" });
    }
  }
  return components;
}

/**
 * @param {unknown} bom
 */
export function assertCycloneDxShape(bom) {
  if (!bom || typeof bom !== "object") {
    throw new Error(`${OBLIGATIONS.NO_COMPONENTS}:not_an_object`);
  }
  const b = /** @type {Record<string, unknown>} */ (bom);
  if (b.bomFormat !== "CycloneDX") {
    throw new Error(`${OBLIGATIONS.NO_COMPONENTS}:bomFormat`);
  }
  if (b.specVersion !== "1.5") {
    throw new Error(`${OBLIGATIONS.NO_COMPONENTS}:specVersion`);
  }
  if (!Array.isArray(b.components) || b.components.length === 0) {
    throw new Error(OBLIGATIONS.NO_COMPONENTS);
  }
  return true;
}

/**
 * @param {{
 *   outDir?: string,
 *   repoRoot?: string,
 *   subjectId?: string,
 *   deviceId?: string,
 * }} [opts]
 */
export function generateReleaseSboms(opts = {}) {
  const outDir = opts.outDir ?? SBOM_OUT_DIR;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const subjectId = opts.subjectId ?? "ci-sbom-generate";
  const deviceId = opts.deviceId ?? "ci";

  mkdirSync(outDir, { recursive: true });

  const rootPkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const releaseVersion =
    typeof rootPkg.version === "string" ? rootPkg.version : "0.0.0";

  const npmComponents = listPublishableNpmPackages(
    path.join(repoRoot, "packages"),
  );
  const npmBom = buildCycloneDxBom({
    name: "moolamai-sutra-npm",
    version: releaseVersion,
    components: npmComponents,
  });
  assertCycloneDxShape(npmBom);

  const pipComponents = listPythonDirectDeps(
    path.join(repoRoot, "packages", "cloud-orchestrator", "pyproject.toml"),
  );
  const pipBom = buildCycloneDxBom({
    name: "sutra-sdk",
    version: releaseVersion,
    type: "library",
    components:
      pipComponents.length > 0
        ? pipComponents
        : [{ name: "sutra-sdk", version: releaseVersion, eco: "pypi" }],
  });
  assertCycloneDxShape(pipBom);

  const npmPath = path.join(outDir, "npm-workspace.cdx.json");
  const pipPath = path.join(outDir, "sutra-sdk-python.cdx.json");
  try {
    writeFileSync(npmPath, `${JSON.stringify(npmBom, null, 2)}\n`, "utf8");
    writeFileSync(pipPath, `${JSON.stringify(pipBom, null, 2)}\n`, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: OBLIGATIONS.WRITE_FAILED,
      message,
    });
    throw err;
  }

  emit({
    outcome: "ok",
    subjectId,
    deviceId,
    npmComponents: npmComponents.length,
    pipComponents: pipComponents.length,
    npmPath: path.relative(repoRoot, npmPath).replace(/\\/g, "/"),
    pipPath: path.relative(repoRoot, pipPath).replace(/\\/g, "/"),
  });

  return {
    ok: true,
    npmPath,
    pipPath,
    npmBom,
    pipBom,
    npmComponents: npmComponents.length,
    pipComponents: pipComponents.length,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  try {
    generateReleaseSboms();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
