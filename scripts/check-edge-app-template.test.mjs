/**
 * Unit tests for templates/edge-app integration template.
 * Run from repo root: node --test scripts/check-edge-app-template.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDGE_APP_TEMPLATE_ROOT,
  OBLIGATIONS,
  validateEdgeAppPackageJson,
} from "./verify-edge-app-template.mjs";
import { runEdgeAppTemplateProve } from "./prove-edge-app-template-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: edge-app template has Expo entry, StorageDriver, mocks, smoke", () => {
  assert.ok(existsSync(path.join(EDGE_APP_TEMPLATE_ROOT, "App.tsx")));
  assert.ok(existsSync(path.join(EDGE_APP_TEMPLATE_ROOT, "app.json")));
  assert.ok(existsSync(path.join(EDGE_APP_TEMPLATE_ROOT, "src/bindings/storage.ts")));
  assert.ok(existsSync(path.join(EDGE_APP_TEMPLATE_ROOT, "src/mocks/reference-bindings.ts")));
  assert.ok(existsSync(path.join(EDGE_APP_TEMPLATE_ROOT, "src/companion.ts")));
  assert.ok(existsSync(path.join(EDGE_APP_TEMPLATE_ROOT, "scripts/smoke.ts")));

  const storage = readFileSync(
    path.join(EDGE_APP_TEMPLATE_ROOT, "src/bindings/storage.ts"),
    "utf8",
  );
  assert.match(storage, /StorageDriver/);
  assert.match(storage, /expo-sqlite/);
  assert.match(storage, /subjectId/);

  const companion = readFileSync(
    path.join(EDGE_APP_TEMPLATE_ROOT, "src/companion.ts"),
    "utf8",
  );
  assert.match(companion, /CognitiveCore/);
  assert.match(companion, /runEdgeTurn/);

  const app = readFileSync(path.join(EDGE_APP_TEMPLATE_ROOT, "App.tsx"), "utf8");
  assert.match(app, /react-native/);
  assert.match(app, /runEdgeTurn/);

  const pkg = JSON.parse(
    readFileSync(path.join(EDGE_APP_TEMPLATE_ROOT, "package.json"), "utf8"),
  );
  assert.equal(validateEdgeAppPackageJson(pkg).status, 0);
  assert.doesNotMatch(JSON.stringify(pkg), /workspace:/);
});

test("edge: workspace protocol dependency fails package gate", () => {
  const result = validateEdgeAppPackageJson({
    dependencies: { "sutra-sdk": "workspace:*" },
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.WORKSPACE_PROTOCOL),
  );
});

test("edge: missing sutra-sdk fails package gate", () => {
  const result = validateEdgeAppPackageJson({ dependencies: {} });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.TEMPLATE_MISSING),
  );
});

test("sovereignty: storage and smoke encode subject isolation", () => {
  const storage = readFileSync(
    path.join(EDGE_APP_TEMPLATE_ROOT, "src/bindings/storage.ts"),
    "utf8",
  );
  assert.match(storage, /subjectId\}::/);
  assert.match(storage, /subjectId is required/);

  const smoke = readFileSync(
    path.join(EDGE_APP_TEMPLATE_ROOT, "scripts/smoke.ts"),
    "utf8",
  );
  assert.match(smoke, /cross-subject/);
  assert.match(smoke, /subject isolation/);
  assert.match(smoke, /integration_templates\.edge_app\.smoke/);
  // Observability emit must not log raw utterance content.
  assert.doesNotMatch(smoke, /emit\(\{[^}]*utterance/);
});

test("ci workflow runs edge-app template verify and prove", () => {
  const text = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(text, /verify-edge-app-template\.mjs/);
  assert.match(text, /prove-edge-app-template-gate\.mjs/);
  assert.match(text, /check-edge-app-template\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["integration:edge-app:verify"],
    "node scripts/verify-edge-app-template.mjs",
  );
  assert.equal(
    pkg.scripts["integration:edge-app:prove"],
    "node scripts/prove-edge-app-template-gate.mjs",
  );
});

test("prove gate red→green for edge-app template", () => {
  const result = runEdgeAppTemplateProve();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});
