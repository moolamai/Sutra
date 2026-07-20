/**
 * LLM-judge policy machine mirror (C3) — governance constants + coherence gate.
 *
 * Aspect-separated optional lane: critics/llm_judge_lane.ts
 * Law: docs/learning/LLM_JUDGE_POLICY.md
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo-relative path to the binding governance document. */
export const LLM_JUDGE_POLICY_RELPATH =
  "docs/learning/LLM_JUDGE_POLICY.md" as const;

/** Closed set of allowed non-verifiable aspects (canonical sorted order). */
export const LLM_JUDGE_ALLOWED_ASPECTS = Object.freeze([
  "clarity",
  "tone",
] as const);

export type LlmJudgeAspect = (typeof LLM_JUDGE_ALLOWED_ASPECTS)[number];

/** Hard denylist — owned exclusively by rule critics / pack oracles. */
export const LLM_JUDGE_FORBIDDEN_DOMAINS = Object.freeze([
  "citations",
  "contract_obligations",
  "mastery_math",
  "schema_validity",
] as const);

export type LlmJudgeForbiddenDomain =
  (typeof LLM_JUDGE_FORBIDDEN_DOMAINS)[number];

/** Default agreement threshold for the judge eval gate. */
export const LLM_JUDGE_DEFAULT_AGREEMENT_THRESHOLD = 0.85;

/** Max judge calls per turn (one per allowed aspect). */
export const LLM_JUDGE_MAX_CALLS_PER_TURN = LLM_JUDGE_ALLOWED_ASPECTS.length;

export type LlmJudgePolicyFailureClass =
  | "llm_judge.forbidden_aspect"
  | "llm_judge.forbidden_domain"
  | "llm_judge.multi_aspect_call"
  | "llm_judge.unpinned_identity"
  | "llm_judge.subject_scope"
  | "llm_judge.policy_incoherent"
  | "llm_judge.source_missing"
  | "llm_judge.section_limit"
  | "llm_judge.not_held_out"
  | "llm_judge.agreement_below_threshold"
  | "llm_judge.insufficient_pairs"
  | "llm_judge.gate_rejected"
  | "llm_judge.hash_mismatch"
  | "llm_judge.schema_violation"
  | "llm_judge.calibration_independence";

export type LlmJudgePolicyTelemetryEvent = {
  event: "learning.critic.llm_judge_policy";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  aspect?: LlmJudgeAspect;
  judgeModelId?: string;
  judgePromptVersion?: string;
  failureClass?: LlmJudgePolicyFailureClass;
};

export class LlmJudgePolicyContractError extends Error {
  readonly obligation: LlmJudgePolicyFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: LlmJudgePolicyFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "LlmJudgePolicyContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}

/**
 * True iff aspect is in the closed allowed set.
 */
export function isAllowedLlmJudgeAspect(
  aspect: string,
): aspect is LlmJudgeAspect {
  return (LLM_JUDGE_ALLOWED_ASPECTS as readonly string[]).includes(aspect);
}

/**
 * Assert aspect is allowed; throws on forbidden / unknown.
 */
export function assertAllowedLlmJudgeAspect(
  aspect: string,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LlmJudgePolicyTelemetryEvent) => void;
  },
): LlmJudgeAspect {
  if (!isAllowedLlmJudgeAspect(aspect)) {
    opts?.onTelemetry?.({
      event: "learning.critic.llm_judge_policy",
      outcome: "fail",
      subjectId: opts.subjectId ?? "llm-judge-policy",
      deviceId: opts.deviceId ?? "ci",
      failureClass: "llm_judge.forbidden_aspect",
    });
    throw new LlmJudgePolicyContractError(
      `LLM judge aspect '${aspect}' is not allowed (tone|clarity only)`,
      {
        obligation: "llm_judge.forbidden_aspect",
        failingSlice: aspect,
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      },
    );
  }
  return aspect;
}

/**
 * Assert a domain id is not on the verifiable denylist.
 */
export function assertNotForbiddenLlmJudgeDomain(
  domain: string,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LlmJudgePolicyTelemetryEvent) => void;
  },
): { ok: true } {
  if ((LLM_JUDGE_FORBIDDEN_DOMAINS as readonly string[]).includes(domain)) {
    opts?.onTelemetry?.({
      event: "learning.critic.llm_judge_policy",
      outcome: "fail",
      subjectId: opts.subjectId ?? "llm-judge-policy",
      deviceId: opts.deviceId ?? "ci",
      failureClass: "llm_judge.forbidden_domain",
    });
    throw new LlmJudgePolicyContractError(
      `LLM judge must not score verifiable domain '${domain}'`,
      {
        obligation: "llm_judge.forbidden_domain",
        failingSlice: domain,
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      },
    );
  }
  return { ok: true };
}

/**
 * Assert judge call pins model + prompt version (opaque ids only).
 */
export function assertLlmJudgeIdentityPinned(opts: {
  judgeModelId: string;
  judgePromptVersion: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: LlmJudgePolicyTelemetryEvent) => void;
}): { ok: true } {
  const modelOk =
    typeof opts.judgeModelId === "string" &&
    opts.judgeModelId.length > 0 &&
    opts.judgeModelId.length <= 128;
  const promptOk =
    typeof opts.judgePromptVersion === "string" &&
    opts.judgePromptVersion.length > 0 &&
    opts.judgePromptVersion.length <= 64;
  if (!modelOk || !promptOk) {
    opts.onTelemetry?.({
      event: "learning.critic.llm_judge_policy",
      outcome: "fail",
      subjectId: opts.subjectId ?? "llm-judge-policy",
      deviceId: opts.deviceId ?? "ci",
      failureClass: "llm_judge.unpinned_identity",
    });
    throw new LlmJudgePolicyContractError(
      "judgeModelId and judgePromptVersion must be non-empty pinned ids",
      {
        obligation: "llm_judge.unpinned_identity",
        ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      },
    );
  }
  // Sovereignty: refuse ids that look like raw prompt bodies
  if (
    /\n/.test(opts.judgeModelId) ||
    /\n/.test(opts.judgePromptVersion) ||
    opts.judgeModelId.length > 128
  ) {
    throw new LlmJudgePolicyContractError(
      "judge identity ids must be opaque (no multiline bodies)",
      {
        obligation: "llm_judge.unpinned_identity",
        ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
      },
    );
  }
  return { ok: true };
}

/**
 * Load the governance document text.
 */
export function loadLlmJudgePolicyDocument(opts?: {
  repoRoot?: string;
  onTelemetry?: (e: LlmJudgePolicyTelemetryEvent) => void;
}): { text: string; relpath: typeof LLM_JUDGE_POLICY_RELPATH } {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const abs = path.join(root, LLM_JUDGE_POLICY_RELPATH);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    opts?.onTelemetry?.({
      event: "learning.critic.llm_judge_policy",
      outcome: "fail",
      subjectId: "llm-judge-policy",
      deviceId: "ci",
      failureClass: "llm_judge.source_missing",
    });
    throw new LlmJudgePolicyContractError(
      `LLM judge policy missing: ${LLM_JUDGE_POLICY_RELPATH}`,
      { obligation: "llm_judge.source_missing" },
    );
  }
  return { text, relpath: LLM_JUDGE_POLICY_RELPATH };
}

/**
 * Assert the governance doc is coherent with machine constants + invariants.
 */
export function assertLlmJudgePolicyCoherent(
  text: string,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LlmJudgePolicyTelemetryEvent) => void;
  },
): { ok: true } {
  const subjectId = opts?.subjectId ?? "llm-judge-policy";
  const deviceId = opts?.deviceId ?? "ci";

  const requiredPhrases = [
    "LLM-judge policy",
    "tone",
    "clarity",
    "mastery math",
    "citations",
    "schema validity",
    "contract obligations",
    "separate call",
    "never replaces rule critics",
    "judgeModelId",
    "judgePromptVersion",
    "subjectId",
    "hack:check",
    "learning.critic.llm_judge_policy",
  ];

  for (const phrase of requiredPhrases) {
    if (!text.toLowerCase().includes(phrase.toLowerCase())) {
      opts?.onTelemetry?.({
        event: "learning.critic.llm_judge_policy",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: "llm_judge.policy_incoherent",
      });
      throw new LlmJudgePolicyContractError(
        `LLM judge policy missing required phrase: ${phrase}`,
        {
          obligation: "llm_judge.policy_incoherent",
          failingSlice: phrase,
          subjectId,
          deviceId,
        },
      );
    }
  }

  for (const aspect of LLM_JUDGE_ALLOWED_ASPECTS) {
    if (!text.includes(`\`${aspect}\``) && !text.includes(aspect)) {
      throw new LlmJudgePolicyContractError(
        `policy must document allowed aspect ${aspect}`,
        {
          obligation: "llm_judge.policy_incoherent",
          failingSlice: aspect,
          subjectId,
          deviceId,
        },
      );
    }
  }

  for (const domain of LLM_JUDGE_FORBIDDEN_DOMAINS) {
    // Doc uses prose names; also require code-ish ids where present
    const aliases: Record<LlmJudgeForbiddenDomain, string[]> = {
      mastery_math: ["mastery_math", "mastery math"],
      citations: ["citations"],
      schema_validity: ["schema_validity", "schema validity"],
      contract_obligations: ["contract_obligations", "contract obligations"],
    };
    const ok = aliases[domain].some((a) =>
      text.toLowerCase().includes(a.toLowerCase()),
    );
    if (!ok) {
      throw new LlmJudgePolicyContractError(
        `policy must document forbidden domain ${domain}`,
        {
          obligation: "llm_judge.policy_incoherent",
          failingSlice: domain,
          subjectId,
          deviceId,
        },
      );
    }
  }

  // Sovereignty: doc must not embed raw utterance example bodies as content keys
  if (/"utterance"\s*:/.test(text) || /"keystrokes"\s*:/.test(text)) {
    throw new LlmJudgePolicyContractError(
      "policy must not embed utterance/keystroke JSON bodies",
      {
        obligation: "llm_judge.policy_incoherent",
        failingSlice: "sovereignty",
        subjectId,
        deviceId,
      },
    );
  }

  opts?.onTelemetry?.({
    event: "learning.critic.llm_judge_policy",
    outcome: "ok",
    subjectId,
    deviceId,
  });
  return { ok: true };
}

/**
 * CI entry: load + assert governance doc coherence.
 */
export function proveLlmJudgePolicyGate(opts?: {
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: LlmJudgePolicyTelemetryEvent) => void;
}): { ok: true; relpath: typeof LLM_JUDGE_POLICY_RELPATH } {
  const loaded = loadLlmJudgePolicyDocument({
    ...(opts?.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  assertLlmJudgePolicyCoherent(loaded.text, {
    ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  // Idempotent replay
  const again = loadLlmJudgePolicyDocument({
    ...(opts?.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
  });
  if (again.text !== loaded.text) {
    throw new LlmJudgePolicyContractError(
      "LLM judge policy reload is not byte-identical (idempotency)",
      { obligation: "llm_judge.policy_incoherent" },
    );
  }

  return { ok: true, relpath: loaded.relpath };
}
