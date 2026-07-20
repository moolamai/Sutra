/**
 * Release workflow provenance gate for npm publish attestation.
 *
 * Ensures release.yml grants GitHub OIDC (id-token: write) and that real
 * publishes enable npm provenance when targeting registry.npmjs.org.
 *
 * Usage (repo root):
 *   node scripts/check-release-provenance.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const RELEASE_WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "release.yml",
);

export const OBLIGATIONS = Object.freeze({
  WORKFLOW_MISSING: "provenance.workflow.missing",
  ID_TOKEN_PERMISSION: "provenance.permissions.id_token_write",
  PROVENANCE_ENV: "provenance.workflow.env_flag",
  PUBLISH_WRAPPER: "provenance.publish.wrapper",
  CHECKLIST_DOCS: "provenance.checklist.docs",
});

export const NPM_PROD_REGISTRY = "https://registry.npmjs.org";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "release.provenance.gate", ...event })}\n`,
  );
}

export function loadReleaseWorkflow(workflowPath = RELEASE_WORKFLOW_PATH) {
  if (!existsSync(workflowPath)) {
    throw new Error(`RELEASE_WORKFLOW_MISSING:${workflowPath}`);
  }
  return readFileSync(workflowPath, "utf8");
}

export function validateReleaseProvenanceConfig(
  workflowText,
  checklistText = existsSync(path.join(REPO_ROOT, "docs", "sdk", "PUBLISH-CHECKLIST.md"))
    ? readFileSync(path.join(REPO_ROOT, "docs", "sdk", "PUBLISH-CHECKLIST.md"), "utf8")
    : "",
) {
  const violations = [];

  if (!workflowText) {
    violations.push({
      obligation: OBLIGATIONS.WORKFLOW_MISSING,
      detail: "release workflow file is empty",
    });
    return { status: 1, violations };
  }

  if (!/id-token:\s*write/m.test(workflowText)) {
    violations.push({
      obligation: OBLIGATIONS.ID_TOKEN_PERMISSION,
      detail: "release.yml must grant permissions.id-token: write for npm OIDC provenance",
    });
  }

  if (!/PROVENANCE_ENABLED/m.test(workflowText)) {
    violations.push({
      obligation: OBLIGATIONS.PROVENANCE_ENV,
      detail: "release.yml must resolve PROVENANCE_ENABLED for publish steps",
    });
  }

  if (!/run-changeset-publish\.mjs/m.test(workflowText)) {
    violations.push({
      obligation: OBLIGATIONS.PUBLISH_WRAPPER,
      detail: "release.yml must invoke scripts/run-changeset-publish.mjs for publish",
    });
  }

  if (checklistText) {
    const requiredSnippets = [
      "id-token",
      "OIDC",
      "provenance",
      "NPM_TOKEN",
      "trusted publishing",
    ];
    for (const snippet of requiredSnippets) {
      if (!checklistText.toLowerCase().includes(snippet.toLowerCase())) {
        violations.push({
          obligation: OBLIGATIONS.CHECKLIST_DOCS,
          detail: `PUBLISH-CHECKLIST.md must document provenance prerequisite: ${snippet}`,
        });
      }
    }
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
  };
}

export function resolveProvenanceForPublish(opts = {}) {
  const dryRun =
    opts.dryRun === true ||
    process.env.NPM_CONFIG_DRY_RUN === "true" ||
    process.argv.includes("--dry-run");
  const registry = String(
    opts.registry ?? process.env.registry ?? process.env.NPM_CONFIG_REGISTRY ?? "",
  ).trim();
  const provenanceFlag = String(process.env.PROVENANCE_ENABLED ?? "").toLowerCase();
  const explicitEnabled = provenanceFlag === "true";
  const explicitDisabled = provenanceFlag === "false";
  const registryIsNpmProd =
    registry === NPM_PROD_REGISTRY || registry.startsWith(`${NPM_PROD_REGISTRY}/`);

  if (dryRun) {
    return { enabled: false, reason: "dry-run" };
  }

  if (explicitDisabled) {
    return { enabled: false, reason: "disabled-by-flag" };
  }

  if (explicitEnabled || registryIsNpmProd) {
    if (!process.env.GITHUB_ACTIONS) {
      return {
        enabled: false,
        violation: {
          obligation: "provenance.publish.ci_only",
          detail: "npm provenance publish is CI-only — workflow is the only publish path",
        },
      };
    }
    return { enabled: true, reason: explicitEnabled ? "workflow-flag" : "npm-registry" };
  }

  return { enabled: false, reason: "scratch-registry" };
}

export function runReleaseProvenanceGate(opts = {}) {
  const subjectId = opts.subjectId ?? "ci-release-provenance";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;
  const workflowText = opts.workflowText ?? loadReleaseWorkflow(opts.workflowPath);
  const result = validateReleaseProvenanceConfig(workflowText, opts.checklistText);

  if (emitEvents) {
    emit({
      outcome: result.status === 0 ? "ok" : "fail",
      subjectId,
      deviceId,
      violationCount: result.violations.length,
    });
  }

  const combined =
    result.status === 0
      ? "OK: release provenance gate configuration is valid"
      : `RELEASE_PROVENANCE_FAILED (${result.violations.length} violation(s)):\n${result.violations
          .map((v) => `[${v.obligation}] ${v.detail}`)
          .join("\n")}`;

  return { ...result, combined };
}

function main() {
  const result = runReleaseProvenanceGate();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
