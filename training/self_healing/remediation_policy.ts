/**
 * Training façade for remediation policies — re-exports the harness schema,
 * executor, and fixture prove APIs; loads seeded fixtures from disk.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RemediationPolicyContractError,
  type RemediationPolicyTelemetryEvent,
} from "../../packages/runtime-harness/dist/self_healing/remediation_policy.js";
import type { RemediationExecutorTelemetryEvent } from "../../packages/runtime-harness/dist/self_healing/remediation_executor.js";
import {
  REMEDIATION_FIXTURE_SCHEMA_VERSION,
  REMEDIATION_FIXTURES_RELPATH,
  proveRemediationFixturesCi as proveRemediationFixturesFromDocs,
  type RemediationFixtureDocument,
  type RemediationFixtureTelemetryEvent,
} from "../../packages/runtime-harness/dist/self_healing/remediation_prove.js";

export {
  FORBIDDEN_REMEDIATION_SURFACES,
  REMEDIATION_ACTION_KINDS,
  REMEDIATION_CONTROL_SURFACES,
  REMEDIATION_CORRECTION_CAP_DEFAULT,
  REMEDIATION_CORRECTION_CAP_MAX,
  REMEDIATION_CORRECTION_CAP_MIN,
  REMEDIATION_DEGRADATION_BEHAVIORS,
  REMEDIATION_DEGRADATION_DEPENDENCIES,
  REMEDIATION_FAILURE_CLASSES,
  REMEDIATION_INEFFECTIVE_ATTEMPT_LIMIT,
  REMEDIATION_POLICY_FLAG,
  REMEDIATION_POLICY_ROW_LIMIT,
  REMEDIATION_POLICY_SCHEMA_VERSION,
  REMEDIATION_RETRY_BUDGET_MAX,
  REMEDIATION_RETRY_BUDGET_MIN,
  REMEDIATION_ROUTING_FALLBACKS,
  RemediationPolicyContractError,
  buildRemediationPolicyDraft,
  createRemediationPolicyCatalog,
  isRemediationAction,
  nextIneffectiveAttemptPolicy,
  parseRemediationAction,
  parseRemediationPolicy,
  selectRemediationPolicy,
  type AdjustRetryBudgetAction,
  type ForbiddenRemediationSurface,
  type RemediationAction,
  type RemediationActionKind,
  type RemediationControlSurface,
  type RemediationDegradationBehavior,
  type RemediationDegradationDependency,
  type RemediationFailureClass,
  type RemediationLocality,
  type RemediationPolicyCatalog,
  type RemediationPolicyDocument,
  type RemediationPolicyFailureClass,
  type RemediationPolicyTelemetryEvent,
  type RemediationRoutingFallback,
  type SetCorrectionLoopCapAction,
  type SetRoutingFallbackAction,
  type SwitchDegradationModeAction,
} from "../../packages/runtime-harness/dist/self_healing/remediation_policy.js";

export {
  REMEDIATION_EXECUTION_RECEIPT_LIMIT,
  REMEDIATION_EXECUTOR_FLAG,
  REMEDIATION_EXECUTOR_SCHEMA_VERSION,
  RemediationExecutorContractError,
  createInMemoryRemediationSurfaces,
  createRemediationExecutor,
  type ExecuteRemediationInput,
  type InMemoryRemediationSurfaceState,
  type RemediationControlSurfacePorts,
  type RemediationExecuteResult,
  type RemediationExecutor,
  type RemediationExecutorFailureClass,
  type RemediationExecutorTelemetryEvent,
  type ReportRemediationOutcomeInput,
} from "../../packages/runtime-harness/dist/self_healing/remediation_executor.js";

export {
  REMEDIATION_FIXTURES_RELPATH,
  REMEDIATION_FIXTURE_SCHEMA_VERSION,
  proveRemediationFixture,
  type RemediationFixtureDocument,
  type RemediationFixtureExpectation,
  type RemediationFixtureKind,
  type RemediationFixturePolicySeed,
  type RemediationFixtureProbe,
  type RemediationFixtureTelemetryEvent,
} from "../../packages/runtime-harness/dist/self_healing/remediation_prove.js";

type FixtureManifest = {
  schemaVersion: string;
  fixtures: Array<{ id: string; file: string }>;
};

function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readJsonObject(absolutePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch {
    throw new RemediationPolicyContractError(`${label} is missing`, {
      obligation: "remediation_policy.invalid_input",
    });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RemediationPolicyContractError(`${label} must be valid JSON`, {
      obligation: "remediation_policy.invalid_input",
    });
  }
}

/** Load seeded remediation fixtures from disk (metadata-only). */
export function loadRemediationFixtures(options?: {
  repoRoot?: string;
}): RemediationFixtureDocument[] {
  const root = options?.repoRoot ?? repoRootFromHere();
  const dir = join(root, REMEDIATION_FIXTURES_RELPATH);
  const manifest = readJsonObject(
    join(dir, "manifest.json"),
    "remediation fixture manifest",
  ) as FixtureManifest;
  if (
    manifest.schemaVersion !== REMEDIATION_FIXTURE_SCHEMA_VERSION ||
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length < 1 ||
    manifest.fixtures.length > 64
  ) {
    throw new RemediationPolicyContractError(
      "remediation fixture manifest is invalid",
      { obligation: "remediation_policy.invalid_input" },
    );
  }
  const seen = new Set<string>();
  const fixtures: RemediationFixtureDocument[] = [];
  for (const entry of manifest.fixtures) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.file !== "string" ||
      seen.has(entry.id) ||
      entry.file.includes("..") ||
      entry.file.includes("\\") ||
      entry.file.includes("/")
    ) {
      throw new RemediationPolicyContractError(
        `invalid remediation fixture manifest entry ${String(entry.id)}`,
        { obligation: "remediation_policy.invalid_input" },
      );
    }
    seen.add(entry.id);
    const parsed = readJsonObject(
      join(dir, entry.file),
      `remediation fixture ${entry.id}`,
    ) as RemediationFixtureDocument;
    if (parsed.id !== entry.id) {
      throw new RemediationPolicyContractError(
        `fixture id mismatch for ${entry.id}`,
        { obligation: "remediation_policy.invalid_input" },
      );
    }
    fixtures.push(parsed);
  }
  return fixtures;
}

/**
 * CI prove: permission widen refused; seeded failure within budget;
 * exhausted remediation disables policy.
 */
export async function proveRemediationFixturesCi(options?: {
  repoRoot?: string;
  deviceId?: string;
  onTelemetry?: (
    event:
      | RemediationFixtureTelemetryEvent
      | RemediationPolicyTelemetryEvent
      | RemediationExecutorTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  refuseFixtureIds: string[];
  remediateFixtureIds: string[];
  exhaustFixtureIds: string[];
  permissionWidenRefused: true;
  withinBudgetOk: true;
  exhaustedDisablesOk: true;
}> {
  const fixtures = loadRemediationFixtures({
    ...(options?.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  const serialized = JSON.stringify(fixtures);
  if (/utterance|secret|learner content/i.test(serialized)) {
    throw new RemediationPolicyContractError(
      "remediation fixtures must stay metadata-only",
      { obligation: "remediation_policy.raw_content_forbidden" },
    );
  }
  return proveRemediationFixturesFromDocs({
    fixtures,
    ...(options?.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options?.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}
