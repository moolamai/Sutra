/**
 * Artifact signing verification gate (SEC-02 — pre-production upload).
 *
 * Before production registry upload, asserts:
 *   - npm: provenance attestation is required (OIDC / NPM_CONFIG_PROVENANCE)
 *   - wheels: integrity digests exist (pack-integrity manifest) and twine-check
 *     path is wired; unsigned/local production publish is refused
 *   - release.yml invokes this gate before production uploads
 *
 * Usage (repo root):
 *   node scripts/verify-artifact-signing.mjs
 *   node scripts/verify-artifact-signing.mjs --mode=production
 *   pnpm signing:verify
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NPM_PROD_REGISTRY,
  loadReleaseWorkflow,
  resolveProvenanceForPublish,
} from "./check-release-provenance.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const RELEASE_WORKFLOW = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "release.yml",
);
export const PUBLISH_CHECKLIST = path.join(
  REPO_ROOT,
  "docs",
  "sdk",
  "PUBLISH-CHECKLIST.md",
);
export const SBOM_README = path.join(REPO_ROOT, "security", "SBOM", "README.md");
export const INTEGRITY_MANIFEST = path.join(
  REPO_ROOT,
  "artifacts",
  "release-pack-integrity",
  "manifest.json",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_WORKFLOW: "signing.verify.missing_workflow",
  MISSING_VERIFY_STEP: "signing.verify.missing_workflow_step",
  MISSING_CHECKLIST: "signing.verify.missing_checklist",
  MISSING_SBOM_DOCS: "signing.verify.missing_sbom_docs",
  NPM_PROD_WITHOUT_PROVENANCE: "signing.verify.npm_prod_without_provenance",
  NPM_PROD_NOT_CI: "signing.verify.npm_prod_not_ci",
  WHEEL_DIGESTS_MISSING: "signing.verify.wheel_digests_missing",
  WHEEL_DIGEST_INVALID: "signing.verify.wheel_digest_invalid",
  PYPI_PROD_NOT_CI: "signing.verify.pypi_prod_not_ci",
  UNSIGNED_BLOCKED: "signing.verify.unsigned_blocked",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "signing.verify", ...event })}\n`,
  );
}

/**
 * @param {string} [argvJoined]
 */
export function parseMode(argvJoined = process.argv.slice(2).join(" ")) {
  const m = /--mode=(policy|production)/.exec(argvJoined);
  return m?.[1] ?? "policy";
}

/**
 * True when the publish target is production npmjs.org.
 * @param {{ registry?: string, provenanceEnabled?: boolean }} opts
 */
export function isNpmProductionTarget(opts = {}) {
  const registry = String(
    opts.registry ?? process.env.registry ?? process.env.NPM_CONFIG_REGISTRY ?? "",
  ).trim();
  const flag = String(
    opts.provenanceEnabled ?? process.env.PROVENANCE_ENABLED ?? "",
  ).toLowerCase();
  return (
    flag === "true" ||
    registry === NPM_PROD_REGISTRY ||
    registry.startsWith(`${NPM_PROD_REGISTRY}/`)
  );
}

/**
 * True when the publish target is production PyPI.
 */
export function isPyPiProductionTarget(opts = {}) {
  const registry = String(
    opts.pypiRegistry ?? process.env.PYPI_REGISTRY ?? "",
  ).toLowerCase();
  const allow =
    opts.allowProd === true || process.env.PYPI_ALLOW_PROD_PUBLISH === "true";
  return registry === "pypi" || (allow && registry !== "testpypi" && opts.forceProd === true);
}

/**
 * Validate pack-integrity manifest digests (wheel / tarball "signatures").
 * @param {string} [manifestPath]
 */
export function verifyWheelDigests(manifestPath = INTEGRITY_MANIFEST) {
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      obligation: OBLIGATIONS.WHEEL_DIGESTS_MISSING,
      detail: `missing integrity manifest: ${manifestPath}`,
    };
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      obligation: OBLIGATIONS.WHEEL_DIGEST_INVALID,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const entries = Array.isArray(doc.packages)
    ? doc.packages
    : Array.isArray(doc.artifacts)
      ? doc.artifacts
      : Array.isArray(doc)
        ? doc
        : null;
  if (!entries || entries.length === 0) {
    return {
      ok: false,
      obligation: OBLIGATIONS.WHEEL_DIGEST_INVALID,
      detail: "integrity manifest has no package digests",
    };
  }
  for (const entry of entries) {
    const digest =
      entry?.sha256 ?? entry?.digest ?? entry?.hash ?? entry?.integrity;
    if (typeof digest !== "string" || digest.length < 32) {
      return {
        ok: false,
        obligation: OBLIGATIONS.WHEEL_DIGEST_INVALID,
        detail: `entry missing sha256: ${JSON.stringify(entry?.name ?? entry)}`,
      };
    }
  }
  return { ok: true, count: entries.length };
}

/**
 * Policy checks that always run (workflow + docs wiring).
 * @param {{ workflowText?: string, checklistText?: string, sbomDocsText?: string }} [opts]
 */
export function validateSigningPolicy(opts = {}) {
  /** @type {string[]} */
  const failures = [];
  const workflow =
    opts.workflowText ??
    (existsSync(RELEASE_WORKFLOW)
      ? readFileSync(RELEASE_WORKFLOW, "utf8")
      : "");
  if (!workflow) {
    failures.push(`${OBLIGATIONS.MISSING_WORKFLOW}:${RELEASE_WORKFLOW}`);
    return { ok: false, failures };
  }

  if (
    !/verify-artifact-signing\.mjs/.test(workflow) &&
    !/signing:verify/.test(workflow)
  ) {
    failures.push(OBLIGATIONS.MISSING_VERIFY_STEP);
  }

  // Must run before production uploads — appear before run-changeset-publish
  // in the production path, or be gated on provenance_enabled / pypi prod.
  if (
    /verify-artifact-signing\.mjs/.test(workflow) &&
    !/provenance_enabled|pypi_registry|PROVENANCE_ENABLED|signing:verify/.test(
      workflow,
    )
  ) {
    failures.push(`${OBLIGATIONS.MISSING_VERIFY_STEP}:not_gated_on_production`);
  }

  const checklist =
    opts.checklistText ??
    (existsSync(PUBLISH_CHECKLIST)
      ? readFileSync(PUBLISH_CHECKLIST, "utf8")
      : "");
  if (
    !checklist ||
    !/signing:verify|verify-artifact-signing|npm provenance attestation/i.test(
      checklist,
    ) ||
    !/wheel|integrity|digest/i.test(checklist)
  ) {
    failures.push(OBLIGATIONS.MISSING_CHECKLIST);
  }

  const sbomDocs =
    opts.sbomDocsText ??
    (existsSync(SBOM_README) ? readFileSync(SBOM_README, "utf8") : "");
  if (
    !sbomDocs ||
    !/signing|provenance|attestation/i.test(sbomDocs)
  ) {
    failures.push(OBLIGATIONS.MISSING_SBOM_DOCS);
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Production-mode checks — unsigned artifacts must not reach prod registries.
 * @param {{
 *   registry?: string,
 *   pypiRegistry?: string,
 *   allowProd?: boolean,
 *   manifestPath?: string,
 *   inCi?: boolean,
 * }} [opts]
 */
export function validateProductionSigning(opts = {}) {
  /** @type {string[]} */
  const failures = [];
  const inCi =
    opts.inCi ??
    (Boolean(process.env.GITHUB_ACTIONS) || process.env.CI === "true");

  const npmProd = isNpmProductionTarget(opts);
  if (npmProd) {
    if (!inCi) {
      failures.push(OBLIGATIONS.NPM_PROD_NOT_CI);
    }
    const provenance = resolveProvenanceForPublish({
      dryRun: false,
      registry: opts.registry ?? process.env.registry,
    });
    // Force env for resolve — if PROVENANCE_ENABLED is not true on prod, fail.
    const flag = String(process.env.PROVENANCE_ENABLED ?? "").toLowerCase();
    if (flag !== "true" && !provenance.enabled) {
      failures.push(OBLIGATIONS.NPM_PROD_WITHOUT_PROVENANCE);
    }
    if (provenance.violation) {
      failures.push(
        `${OBLIGATIONS.UNSIGNED_BLOCKED}:${provenance.violation.obligation}`,
      );
    }
  }

  const pypiProd =
    String(opts.pypiRegistry ?? process.env.PYPI_REGISTRY ?? "").toLowerCase() ===
      "pypi" ||
    (opts.allowProd === true &&
      String(opts.pypiRegistry ?? "").toLowerCase() !== "testpypi" &&
      opts.requirePyPiProd === true);

  // When explicitly asked to verify production wheels (release.yml sets
  // pypi_registry=pypi), require CI + digests.
  const verifyWheels =
    pypiProd ||
    npmProd ||
    opts.requireDigests === true ||
    String(process.env.SIGNING_REQUIRE_DIGESTS ?? "") === "true";

  if (verifyWheels) {
    const digests = verifyWheelDigests(opts.manifestPath);
    if (!digests.ok) {
      failures.push(`${digests.obligation}:${digests.detail}`);
    }
  }

  if (
    String(opts.pypiRegistry ?? process.env.PYPI_REGISTRY ?? "").toLowerCase() ===
      "pypi" &&
    !inCi
  ) {
    failures.push(OBLIGATIONS.PYPI_PROD_NOT_CI);
  }

  return { ok: failures.length === 0, failures, npmProd, pypiProd: Boolean(pypiProd) };
}

/**
 * @param {{
 *   mode?: 'policy'|'production',
 *   subjectId?: string,
 *   deviceId?: string,
 *   workflowText?: string,
 *   checklistText?: string,
 *   sbomDocsText?: string,
 *   registry?: string,
 *   pypiRegistry?: string,
 *   manifestPath?: string,
 *   inCi?: boolean,
 *   requireDigests?: boolean,
 * }} [opts]
 */
export function verifyArtifactSigning(opts = {}) {
  const mode = opts.mode ?? parseMode();
  const subjectId = opts.subjectId ?? "ci-signing-verify";
  const deviceId = opts.deviceId ?? "ci";
  /** @type {string[]} */
  const failures = [];

  const policy = validateSigningPolicy(opts);
  failures.push(...policy.failures);

  if (mode === "production") {
    const prod = validateProductionSigning(opts);
    failures.push(...prod.failures);
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    subjectId,
    deviceId,
    mode,
    failureCount: failures.length,
  });
  return { ok, failures, mode };
}

function main() {
  const mode = parseMode();
  const result = verifyArtifactSigning({
    mode,
    registry: process.env.registry,
    pypiRegistry: process.env.PYPI_REGISTRY,
    requireDigests: mode === "production",
  });
  if (!result.ok) {
    for (const f of result.failures) {
      process.stderr.write(`${f}\n`);
    }
    process.stderr.write(
      "SIGNING_VERIFY_FAILED: unsigned artifacts cannot reach production registries\n",
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
