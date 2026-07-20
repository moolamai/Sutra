/**
 * Load/validate A P6 degradation registry + register() / Behavior enum.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  A_P6_DEGRADATION_REGISTRY_FIXTURE_RELPATH,
  DEGRADATION_BEHAVIORS,
  DEFAULT_DEGRADATION_REGISTRY,
  degradationBehaviorToMode,
  degradationModeToBehavior,
  isDegradationBehavior,
  loadDegradationRegistry,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: load DEFAULT A P6 registry; Behavior enum maps modes", () => {
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.registryVersion, "1.0.0");
  assert.ok(loaded.bindingCount >= 6);

  assert.deepEqual([...DEGRADATION_BEHAVIORS], [
    "stale_with_marker",
    "queue",
    "hard_stop",
  ]);
  assert.equal(degradationModeToBehavior("STALE_READ"), "stale_with_marker");
  assert.equal(degradationModeToBehavior("QUEUE_AND_WARN"), "queue");
  assert.equal(degradationModeToBehavior("HARD_STOP_WRITE"), "hard_stop");
  assert.equal(degradationBehaviorToMode("stale_with_marker"), "STALE_READ");
  assert.ok(isDegradationBehavior("hard_stop"));
  assert.equal(isDegradationBehavior("passthrough"), false);

  // A P6 modes never allow fabrication / silent write retry.
  for (const mode of Object.keys(loaded.registry.document.modes)) {
    const spec = loaded.registry.document.modes[mode];
    assert.equal(spec.allowsFabrication, false);
    assert.equal(spec.allowsSilentWriteRetry, false);
  }

  assert.ok(telemetry.some((t) => t.action === "load" && t.outcome === "ok"));
  assert.ok(!JSON.stringify(telemetry).includes("learner"));

  log({
    event: "runtime.harness.degradation_registry",
    outcome: "ok",
    case: "load",
    registryVersion: loaded.registryVersion,
    bindingCount: loaded.bindingCount,
  });
});

test("happy path: fixture bytes match DEFAULT document version", () => {
  const fixturePath = join(REPO_ROOT, A_P6_DEGRADATION_REGISTRY_FIXTURE_RELPATH);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const loaded = loadDegradationRegistry({ document: fixture });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.registryVersion, DEFAULT_DEGRADATION_REGISTRY.version);
  assert.equal(
    loaded.registry.document.bindings.length,
    DEFAULT_DEGRADATION_REGISTRY.bindings.length,
  );
});

test("happy path: register() API + resolve overlay", () => {
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    subjectId: "anika-k",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);
  const reg = loaded.registry;

  const registered = reg.register("tool", "hard_stop", {
    subjectId: "anika-k",
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.behavior, "hard_stop");
  assert.equal(registered.mode, "HARD_STOP_WRITE");

  const again = reg.register("tool", "hard_stop", { subjectId: "anika-k" });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);

  const conflict = reg.register("tool", "queue", { subjectId: "anika-k" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.failureClass, "conflict");

  const resolved = reg.resolve({
    dependency: "tool",
    operation: "write",
    subjectId: "anika-k",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.behavior, "hard_stop");
  assert.equal(resolved.defaultedHardStop, false);
  assert.equal(resolved.allowsSilentWriteRetry, false);
  assert.equal(resolved.allowsFabrication, false);

  assert.ok(telemetry.some((t) => t.action === "register"));
  assert.ok(telemetry.some((t) => t.action === "resolve" && t.dependency === "tool"));
});

test("edge: unknown dependency defaults to hard_stop (not passthrough)", () => {
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    onTelemetry: (e) => telemetry.push(e),
  });
  const resolved = loaded.registry.resolve({
    dependency: "mystery-adapter",
    operation: "write",
    subjectId: "anika-k",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.behavior, "hard_stop");
  assert.equal(resolved.defaultedHardStop, true);
  assert.equal(resolved.signalCode, "DEGRADE_HARD_STOP_WRITE");
  assert.ok(
    telemetry.some(
      (t) =>
        t.action === "resolve" &&
        t.defaultedHardStop === true &&
        t.failureClass === "unknown_dependency",
    ),
  );
});

test("edge: invalid document rejected; sync read uses stale_with_marker", () => {
  const bad = loadDegradationRegistry({
    document: { version: "1.0.0", modes: {}, bindings: [] },
    subjectId: "anika-k",
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "schema_violation");

  const loaded = loadDegradationRegistry();
  const syncRead = loaded.registry.resolve({
    dependency: "sync",
    operation: "read",
    subjectId: "anika-k",
  });
  assert.equal(syncRead.ok, true);
  assert.equal(syncRead.behavior, "stale_with_marker");
  assert.equal(syncRead.spec.requiresFreshnessMarker, true);
  assert.equal(syncRead.spec.readPolicy, "stale-with-marker");

  const syncWrite = loaded.registry.resolve({
    dependency: "sync",
    operation: "write",
    subjectId: "anika-k",
  });
  assert.equal(syncWrite.behavior, "hard_stop");
  assert.equal(syncWrite.spec.writePolicy, "hard-stop-rollback");
});

test("sovereignty: register/resolve require subjectId; telemetry scoped", () => {
  const telemetry = [];
  const loaded = loadDegradationRegistry({
    onTelemetry: (e) => telemetry.push(e),
  });
  const missing = loaded.registry.register("tool", "hard_stop", {
    subjectId: "  ",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");

  const resolveMissing = loaded.registry.resolve({
    dependency: "model",
    operation: "read",
    subjectId: "",
  });
  assert.equal(resolveMissing.ok, false);
  assert.equal(resolveMissing.failureClass, "missing_subject");
  assert.ok(
    telemetry.every((t) => t.event === "runtime.harness.degradation_registry"),
  );
});

test("partial outage: model up path still queue on model read; sync write hard_stop", () => {
  const loaded = loadDegradationRegistry();
  const modelRead = loaded.registry.resolve({
    dependency: "model",
    operation: "read",
    subjectId: "anika-k",
  });
  assert.equal(modelRead.behavior, "queue");
  assert.equal(modelRead.signalCode, "DEGRADE_QUEUE_AND_WARN");

  const syncWrite = loaded.registry.resolve({
    dependency: "sync",
    operation: "write",
    subjectId: "anika-k",
  });
  assert.equal(syncWrite.behavior, "hard_stop");
});
