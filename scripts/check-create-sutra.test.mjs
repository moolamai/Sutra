/**
 * Unit tests for create-sutra scaffolder.
 * Run from repo root: node --test scripts/check-create-sutra.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateChoices, SDK_VERSION_RANGE } from "../tools/create-sutra/lib/choices.mjs";
import {
  OBLIGATIONS,
  runCreateSutraScaffold,
  substitutePlaceholders,
  validateGeneratedPackageJson,
} from "../tools/create-sutra/lib/scaffold.mjs";
import { runCreateSutraProve } from "./prove-create-sutra-gate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

function scaffoldToTemp(overrides = {}) {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-create-sutra-test-"));
  const outDir = path.join(workRoot, overrides.projectName ?? "test-companion");
  const result = runCreateSutraScaffold({
    projectName: "test-companion",
    domainPack: "teacher",
    storageDriver: "memory",
    transport: "offline",
    outDir,
    emitEvents: false,
    ...overrides,
  });
  return { workRoot, outDir, result };
}

test("happy path: scaffolds project with binding stubs and sutra-sdk dependency", () => {
  const { workRoot, outDir, result } = scaffoldToTemp();
  try {
    assert.equal(result.status, 0, result.combined);
    assert.ok(existsSync(path.join(outDir, "package.json")));
    assert.ok(existsSync(path.join(outDir, "src/bindings/storage.ts")));
    assert.ok(existsSync(path.join(outDir, "src/bindings/transport.ts")));
    assert.ok(existsSync(path.join(outDir, "src/config/domain.ts")));

    const pkg = JSON.parse(readFileSync(path.join(outDir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["sutra-sdk"], SDK_VERSION_RANGE);
    assert.equal(pkg.name, "test-companion");

    const domain = readFileSync(path.join(outDir, "src/config/domain.ts"), "utf8");
    assert.match(domain, /education-mathematics/);
    assert.match(domain, /teacher-cbse-slice/);

    const index = readFileSync(path.join(outDir, "src/index.ts"), "utf8");
    assert.match(index, /subjectId/);
    assert.match(index, /bootstrapBindings/);

    assert.ok(existsSync(path.join(outDir, "src/companion.ts")));
    assert.ok(existsSync(path.join(outDir, "src/mocks/reference-bindings.ts")));
    assert.ok(existsSync(path.join(outDir, "scripts/smoke.ts")));

    const companion = readFileSync(path.join(outDir, "src/companion.ts"), "utf8");
    assert.match(companion, /CognitiveCore/);
    assert.match(companion, /runMockTurn/);

    const domainCfg = readFileSync(path.join(outDir, "src/config/domain.ts"), "utf8");
    assert.match(domainCfg, /agentProfile/);
    assert.match(domainCfg, /taskGraph/);

    const pkgScripts = JSON.parse(readFileSync(path.join(outDir, "package.json"), "utf8")).scripts;
    assert.match(pkgScripts.smoke, /smoke\.ts/);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: invalid project name fails choices gate", () => {
  const result = validateChoices({
    projectName: "Bad_Name",
    domainPack: "teacher",
    storageDriver: "memory",
    transport: "offline",
  });
  assert.equal(result.status, 1);
  assert.ok(result.violations.some((v) => v.obligation === "create_sutra.project_name.invalid"));
});

test("edge: existing output directory fails without overwrite", () => {
  const { workRoot, outDir } = scaffoldToTemp();
  try {
    const second = runCreateSutraScaffold({
      projectName: "test-companion",
      domainPack: "teacher",
      storageDriver: "memory",
      transport: "offline",
      outDir,
      emitEvents: false,
    });
    assert.equal(second.status, 1);
    assert.ok(
      second.violations.some((v) => v.obligation === OBLIGATIONS.OUTPUT_EXISTS),
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: unknown storage driver fails choices gate", () => {
  const result = validateChoices({
    projectName: "valid-name",
    domainPack: "teacher",
    storageDriver: "postgres",
    transport: "offline",
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === "create_sutra.storage_driver.invalid"),
  );
});

test("validateGeneratedPackageJson rejects workspace protocol", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-create-sutra-pkg-"));
  const outDir = path.join(workRoot, "pkg");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify({ dependencies: { "sutra-sdk": "workspace:*" } }, null, 2),
    );
    const check = validateGeneratedPackageJson(outDir);
    assert.equal(check.status, 1);
    assert.ok(
      check.violations.some((v) => v.obligation === OBLIGATIONS.WORKSPACE_PROTOCOL),
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("substitutePlaceholders replaces all template tokens", () => {
  const out = substitutePlaceholders("{{PROJECT_NAME}} uses {{SDK_VERSION}}", {
    PROJECT_NAME: "demo",
    SDK_VERSION: "^0.1.0",
  });
  assert.equal(out, "demo uses ^0.1.0");
});

test("scaffold emits structured event on success", () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "sutra-create-sutra-event-"));
  const outDir = path.join(workRoot, "event-companion");
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const result = runCreateSutraScaffold({
      projectName: "event-companion",
      domainPack: "lawyer",
      storageDriver: "sqlite",
      transport: "http",
      outDir,
      subjectId: "scaffold-subject",
      deviceId: "scaffold-device",
    });
    assert.equal(result.status, 0, result.combined);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = events.find((e) => e.event === "create_sutra.scaffold");
    assert.ok(event);
    assert.equal(event.outcome, "ok");
    assert.equal(event.subjectId, "scaffold-subject");
    assert.equal(event.domainPack, "lawyer");
  } finally {
    process.stdout.write = origWrite;
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("prove gate red→green on invalid project name", () => {
  const result = runCreateSutraProve();
  assert.equal(result.status, 0, result.combined);
});

test("edge: companion template rejects empty subjectId at bootstrap", () => {
  const { workRoot, outDir, result } = scaffoldToTemp();
  try {
    assert.equal(result.status, 0);
    const companion = readFileSync(path.join(outDir, "src/companion.ts"), "utf8");
    assert.match(companion, /subjectId is required/);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("edge: reference bindings template uses contract-shaped memory remember", () => {
  const { workRoot, outDir, result } = scaffoldToTemp();
  try {
    assert.equal(result.status, 0);
    const mocks = readFileSync(path.join(outDir, "src/mocks/reference-bindings.ts"), "utf8");
    assert.match(mocks, /async remember/);
    assert.match(mocks, /deliberate/);
    assert.doesNotMatch(mocks, /workspace:\*/);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("ci workflow runs create-sutra scaffolder tests", () => {
  const text = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(text, /check-create-sutra\.test\.mjs/);
  assert.match(text, /prove-create-sutra-gate\.mjs/);
  assert.match(text, /verify-create-sutra-scaffold\.mjs/);
  assert.match(text, /prove-create-sutra-verify-gate\.mjs/);
  assert.match(text, /--matrix/);
});
