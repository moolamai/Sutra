/**
 * Unit tests for node-service + fastapi-adapter integration templates.
 * Run: node --test scripts/check-integration-templates-002.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_SERVICE_TEMPLATE_ROOT,
  OBLIGATIONS as NODE_OBLIGATIONS,
  validateNodeServicePackageJson,
} from "./verify-node-service-template.mjs";
import {
  FASTAPI_ADAPTER_TEMPLATE_ROOT,
  OBLIGATIONS as FASTAPI_OBLIGATIONS,
  assertNoOrchestratorInternals,
  validateFastapiAdapterPackageJson,
} from "./verify-fastapi-adapter-template.mjs";
import { runIntegrationTemplates002Prove } from "./prove-integration-templates-002-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

test("happy path: node-service has CognitiveCore host, mocks, smoke", () => {
  assert.ok(existsSync(path.join(NODE_SERVICE_TEMPLATE_ROOT, "src/server.ts")));
  assert.ok(existsSync(path.join(NODE_SERVICE_TEMPLATE_ROOT, "src/companion.ts")));
  assert.ok(
    existsSync(path.join(NODE_SERVICE_TEMPLATE_ROOT, "src/mocks/reference-bindings.ts")),
  );
  assert.ok(existsSync(path.join(NODE_SERVICE_TEMPLATE_ROOT, "scripts/smoke.ts")));

  const companion = readFileSync(
    path.join(NODE_SERVICE_TEMPLATE_ROOT, "src/companion.ts"),
    "utf8",
  );
  assert.match(companion, /CognitiveCore/);
  assert.match(companion, /requestId/);
  assert.match(companion, /withSubjectTurnGate/);

  const pkg = JSON.parse(
    readFileSync(path.join(NODE_SERVICE_TEMPLATE_ROOT, "package.json"), "utf8"),
  );
  assert.equal(validateNodeServicePackageJson(pkg).status, 0);
  assert.doesNotMatch(JSON.stringify(pkg), /workspace:/);
});

test("happy path: fastapi-adapter has SyncTransport + FastAPI without orchestrator internals", () => {
  assert.ok(existsSync(path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "app/main.py")));
  assert.ok(existsSync(path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "app/wire_models.py")));
  assert.ok(
    existsSync(
      path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "transport/http_sync_transport.ts"),
    ),
  );
  assert.ok(existsSync(path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "scripts/smoke.py")));

  assert.equal(assertNoOrchestratorInternals(FASTAPI_ADAPTER_TEMPLATE_ROOT).status, 0);

  const transport = readFileSync(
    path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "transport/http_sync_transport.ts"),
    "utf8",
  );
  assert.match(transport, /SyncTransport/);
  assert.match(transport, /subjectId mismatch/);
  assert.doesNotMatch(transport, /sutra_orchestrator/);

  const pkg = JSON.parse(
    readFileSync(path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "package.json"), "utf8"),
  );
  assert.equal(validateFastapiAdapterPackageJson(pkg).status, 0);
});

test("edge: workspace protocol fails package gates", () => {
  const node = validateNodeServicePackageJson({
    dependencies: { "sutra-sdk": "workspace:*" },
  });
  assert.equal(node.status, 1);
  assert.ok(
    node.violations.some((v) => v.obligation === NODE_OBLIGATIONS.WORKSPACE_PROTOCOL),
  );

  const fastapi = validateFastapiAdapterPackageJson({
    dependencies: { "sutra-sdk": "workspace:*" },
  });
  assert.equal(fastapi.status, 1);
  assert.ok(
    fastapi.violations.some(
      (v) => v.obligation === FASTAPI_OBLIGATIONS.WORKSPACE_PROTOCOL,
    ),
  );
});

test("edge: missing sutra-sdk fails package gates", () => {
  assert.equal(validateNodeServicePackageJson({ dependencies: {} }).status, 1);
  assert.equal(validateFastapiAdapterPackageJson({ dependencies: {} }).status, 1);
});

test("sovereignty: subject isolation encoded in both templates", () => {
  const nodeSmoke = readFileSync(
    path.join(NODE_SERVICE_TEMPLATE_ROOT, "scripts/smoke.ts"),
    "utf8",
  );
  assert.match(nodeSmoke, /empty subjectId/);
  assert.match(nodeSmoke, /idempotent/);
  assert.match(nodeSmoke, /cross-subject/);

  const pySmoke = readFileSync(
    path.join(FASTAPI_ADAPTER_TEMPLATE_ROOT, "scripts/smoke.py"),
    "utf8",
  );
  assert.match(pySmoke, /subject mismatch/);
  assert.match(pySmoke, /Idempotent/);
  assert.match(pySmoke, /x-sutra-subject-id/);
});

test("ci workflow runs node-service and fastapi-adapter verify", () => {
  const text = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(text, /verify-node-service-template\.mjs/);
  assert.match(text, /verify-fastapi-adapter-template\.mjs/);
  assert.match(text, /prove-integration-templates-002-gate\.mjs/);
  assert.match(text, /check-integration-templates-002\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    pkg.scripts["integration:node-service:verify"],
    "node scripts/verify-node-service-template.mjs",
  );
  assert.equal(
    pkg.scripts["integration:fastapi-adapter:verify"],
    "node scripts/verify-fastapi-adapter-template.mjs",
  );
  assert.equal(
    pkg.scripts["integration:templates-002:prove"],
    "node scripts/prove-integration-templates-002-gate.mjs",
  );
});

test("prove gate red→green for integration templates 002", () => {
  const result = runIntegrationTemplates002Prove();
  assert.equal(result.status, 0, result.combined);
  assert.match(result.combined, /red→green/);
});
