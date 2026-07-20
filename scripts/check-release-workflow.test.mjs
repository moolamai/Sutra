import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");

function workflowText() {
  return readFileSync(RELEASE_WORKFLOW, "utf8");
}

test("release workflow triggers on version tags and supports PR dry-runs", () => {
  const text = workflowText();
  assert.match(text, /push:\s*\n\s*tags:\s*\n\s*-\s*"v\*\.\*\.\*"/m);
  assert.match(text, /pull_request:/m);
  assert.match(text, /workflow_dispatch:/m);
});

test("release workflow does not gate publish on internal launch checklist", () => {
  const text = workflowText();
  assert.doesNotMatch(text, /cross-track-green:/);
  assert.doesNotMatch(text, /launch-checklist\.mjs/);
  assert.doesNotMatch(text, /needs:\s*\[cross-track-green\]/);
});

test("release workflow executes version, build, pack, publish flow", () => {
  const text = workflowText();
  assert.match(text, /pnpm changeset:config/);
  assert.match(text, /pnpm changeset:version/);
  assert.match(text, /pnpm turbo build/);
  assert.match(text, /pnpm publish:pack/);
  assert.match(text, /run-changeset-publish\.mjs/);
});

test("release workflow keeps production publish behind explicit flag", () => {
  const text = workflowText();
  assert.match(text, /allow_prod_publish/);
  assert.match(text, /NPM_ALLOW_PROD_PUBLISH/);
  assert.match(text, /NPM_SCRATCH_REGISTRY_URL/);
  assert.match(text, /NPM_PROD_REGISTRY_URL/);
});

test("release workflow uploads release artifacts for observability", () => {
  const text = workflowText();
  assert.match(text, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(text, /CHANGELOG\.md/);
  assert.match(text, /\.changeset\/\*\.md/);
});

test("release workflow verifies rehearsal install from scratch registry", () => {
  const text = workflowText();
  assert.match(text, /verify-rehearsal-install\.mjs --from-registry/);
  assert.match(text, /-rehearsal\./);
  assert.match(text, /rehearsal-run\.json/);
});

test("release workflow enables npm provenance with OIDC", () => {
  const text = workflowText();
  assert.match(text, /id-token:\s*write/);
  assert.match(text, /PROVENANCE_ENABLED/);
  assert.match(text, /run-changeset-publish\.mjs/);
});

test("release workflow records and verifies post-pack integrity", () => {
  const text = workflowText();
  assert.match(text, /publish:integrity:record/);
  assert.match(text, /publish:integrity:verify/);
  assert.match(text, /release-pack-integrity\/manifest\.json/);
});

test("release workflow enforces version lockstep before publish", () => {
  const text = workflowText();
  assert.match(text, /version:lockstep/);
});

test("release workflow publishes sutra-sdk to TestPyPI on rehearsal tags", () => {
  const text = workflowText();
  assert.match(text, /run-pypi-publish\.mjs/);
  assert.match(text, /verify-pypi-rehearsal-install\.mjs --from-testpypi/);
  assert.match(text, /TEST_PYPI_API_TOKEN/);
  assert.match(text, /PYPI_ALLOW_PROD_PUBLISH/);
  assert.match(text, /pypi-rehearsal-release\/rehearsal-run\.json/);
});
