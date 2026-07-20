/**
 * Release SBOM wiring gate (SEC-02 — CycloneDX in release workflow).
 *
 * Asserts release.yml generates CycloneDX SBOMs, uploads them as artifacts,
 * and attaches them to GitHub Release assets on tag publish. Also validates
 * security/SBOM docs and PUBLISH-CHECKLIST mention the SBOM obligation.
 *
 * Usage (repo root):
 *   node scripts/check-release-sbom.mjs
 *   pnpm sbom:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SBOM_DOCS_DIR,
  assertCycloneDxShape,
  generateReleaseSboms,
} from "./generate-release-sbom.mjs";

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

export const OBLIGATIONS = Object.freeze({
  MISSING_WORKFLOW: "sbom.release.missing_workflow",
  MISSING_GENERATE: "sbom.release.missing_generate_step",
  MISSING_UPLOAD: "sbom.release.missing_artifact_upload",
  MISSING_GH_RELEASE: "sbom.release.missing_gh_release_attach",
  MISSING_DOCS: "sbom.release.missing_sbom_docs",
  MISSING_CHECKLIST: "sbom.release.missing_publish_checklist",
  GENERATE_FAILED: "sbom.release.generate_failed",
  INVALID_BOM: "sbom.release.invalid_bom",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "sbom.release.check", ...event })}\n`,
  );
}

/**
 * @param {{
 *   workflowPath?: string,
 *   checklistPath?: string,
 *   docsDir?: string,
 *   runGenerate?: boolean,
 *   subjectId?: string,
 *   deviceId?: string,
 * }} [opts]
 */
export function checkReleaseSbom(opts = {}) {
  const workflowPath = opts.workflowPath ?? RELEASE_WORKFLOW;
  const checklistPath = opts.checklistPath ?? PUBLISH_CHECKLIST;
  const docsDir = opts.docsDir ?? SBOM_DOCS_DIR;
  const subjectId = opts.subjectId ?? "ci-sbom-check";
  const deviceId = opts.deviceId ?? "ci";
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(workflowPath)) {
    failures.push(`${OBLIGATIONS.MISSING_WORKFLOW}:${workflowPath}`);
    emit({
      outcome: "fail",
      subjectId,
      deviceId,
      failureCount: failures.length,
    });
    return { ok: false, failures };
  }

  const workflow = readFileSync(workflowPath, "utf8");

  if (
    !/generate-release-sbom\.mjs/.test(workflow) &&
    !/sbom:generate/.test(workflow)
  ) {
    failures.push(OBLIGATIONS.MISSING_GENERATE);
  }

  if (
    !/artifacts\/sbom\/\*\.cdx\.json/.test(workflow) &&
    !/artifacts\/sbom\//.test(workflow)
  ) {
    failures.push(OBLIGATIONS.MISSING_UPLOAD);
  }

  if (
    !/gh release upload/.test(workflow) &&
    !/action-gh-release/.test(workflow)
  ) {
    failures.push(OBLIGATIONS.MISSING_GH_RELEASE);
  }

  const readme = path.join(docsDir, "README.md");
  if (!existsSync(readme)) {
    failures.push(`${OBLIGATIONS.MISSING_DOCS}:${readme}`);
  } else {
    const docs = readFileSync(readme, "utf8");
    if (!/CycloneDX/i.test(docs) || !/\.cdx\.json/.test(docs)) {
      failures.push(`${OBLIGATIONS.MISSING_DOCS}:content`);
    }
  }

  if (!existsSync(checklistPath)) {
    failures.push(`${OBLIGATIONS.MISSING_CHECKLIST}:${checklistPath}`);
  } else {
    const checklist = readFileSync(checklistPath, "utf8");
    if (!/SBOM|CycloneDX/i.test(checklist)) {
      failures.push(OBLIGATIONS.MISSING_CHECKLIST);
    }
  }

  if (opts.runGenerate !== false) {
    try {
      const result = generateReleaseSboms({
        subjectId,
        deviceId,
      });
      try {
        assertCycloneDxShape(result.npmBom);
        assertCycloneDxShape(result.pipBom);
      } catch (err) {
        failures.push(
          `${OBLIGATIONS.INVALID_BOM}:${err instanceof Error ? err.message : err}`,
        );
      }
    } catch (err) {
      failures.push(
        `${OBLIGATIONS.GENERATE_FAILED}:${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    subjectId,
    deviceId,
    failureCount: failures.length,
  });
  return { ok, failures };
}

function main() {
  const result = checkReleaseSbom();
  if (!result.ok) {
    for (const f of result.failures) {
      process.stderr.write(`${f}\n`);
    }
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
