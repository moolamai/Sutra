/**
 * LLM-judge policy governance coherence (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LLM_JUDGE_ALLOWED_ASPECTS,
  LLM_JUDGE_FORBIDDEN_DOMAINS,
  LLM_JUDGE_POLICY_RELPATH,
  LlmJudgePolicyContractError,
  assertAllowedLlmJudgeAspect,
  assertLlmJudgeIdentityPinned,
  assertLlmJudgePolicyCoherent,
  assertNotForbiddenLlmJudgeDomain,
  loadLlmJudgePolicyDocument,
  proveLlmJudgePolicyGate,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

test("happy path: policy loads; coherent with machine constants", () => {
  const events = [];
  const loaded = loadLlmJudgePolicyDocument({
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.relpath, LLM_JUDGE_POLICY_RELPATH);
  assert.ok(loaded.text.includes("tone"));
  assert.ok(loaded.text.includes("clarity"));

  const coherent = assertLlmJudgePolicyCoherent(loaded.text, {
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(coherent.ok, true);
  assert.deepEqual([...LLM_JUDGE_ALLOWED_ASPECTS], ["clarity", "tone"]);
  assert.ok(LLM_JUDGE_FORBIDDEN_DOMAINS.includes("mastery_math"));
  assert.ok(events.some((e) => e.outcome === "ok"));
});

test("edge: forbidden aspect / domain / unpinned identity rejected", () => {
  assert.throws(
    () => assertAllowedLlmJudgeAspect("mastery_math"),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.forbidden_aspect",
  );

  assert.throws(
    () => assertNotForbiddenLlmJudgeDomain("citations"),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.forbidden_domain",
  );

  assert.equal(assertAllowedLlmJudgeAspect("tone"), "tone");
  assert.equal(assertNotForbiddenLlmJudgeDomain("pedagogy_style").ok, true);

  assert.throws(
    () =>
      assertLlmJudgeIdentityPinned({
        judgeModelId: "",
        judgePromptVersion: "v1",
      }),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.unpinned_identity",
  );

  assert.equal(
    assertLlmJudgeIdentityPinned({
      judgeModelId: "judge.tone.local-v1",
      judgePromptVersion: "prompt.tone.1.0.0",
      subjectId: "subj.policy",
      deviceId: "dev.policy",
    }).ok,
    true,
  );
});

test("edge: incoherent / sovereignty-violating doc text rejected; prove idempotent", () => {
  assert.throws(
    () => assertLlmJudgePolicyCoherent("# empty\n"),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.policy_incoherent",
  );

  assert.throws(
    () =>
      assertLlmJudgePolicyCoherent(
        `# LLM-judge policy\ntone clarity mastery math citations schema validity contract obligations separate call never replaces rule critics judgeModelId judgePromptVersion subjectId hack:check learning.critic.llm_judge_policy\n\`tone\` \`clarity\`\n{"utterance":"secret learner text"}`,
      ),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.policy_incoherent" &&
      err.failingSlice === "sovereignty",
  );

  const proved = proveLlmJudgePolicyGate({ repoRoot: REPO_ROOT });
  assert.equal(proved.ok, true);
  assert.equal(proved.relpath, LLM_JUDGE_POLICY_RELPATH);
});
