import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPublicMoolamPackages } from "./check-changeset-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHECKLIST = path.join(REPO_ROOT, "docs", "sdk", "PUBLISH-CHECKLIST.md");

function listPublicPackages() {
  return listPublicMoolamPackages();
}

test("checklist exists and references mandatory gate commands", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  assert.match(text, /pnpm publish:readiness/);
  assert.match(text, /pnpm publish:pack/);
  assert.match(text, /pnpm publish:readiness:prove/);
  assert.match(text, /pnpm publish:pack:prove/);
});

test("checklist contains every public @moolam/* package", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  for (const pkg of listPublicPackages()) {
    assert.match(text, new RegExp(pkg.replace("/", "\\/")));
  }
});

test("checklist dry-run commands target package names", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  for (const pkg of listPublicPackages()) {
    assert.match(text, new RegExp(`pnpm --filter ${pkg.replace("/", "\\/")} pack --dry-run`));
  }
});

test("checklist documents npm provenance prerequisites", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  assert.match(text, /id-token/i);
  assert.match(text, /OIDC/i);
  assert.match(text, /provenance/i);
  assert.match(text, /NPM_TOKEN/);
  assert.match(text, /trusted publishing/i);
  assert.match(text, /pnpm publish:provenance/);
});

test("checklist documents post-pack integrity commands", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  assert.match(text, /pnpm publish:integrity:record/);
  assert.match(text, /pnpm publish:integrity:verify/);
  assert.match(text, /pnpm publish:integrity:prove/);
  assert.match(text, /SHA-256/i);
});
