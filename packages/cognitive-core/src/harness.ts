/**
 * @module harness
 *
 * CognitiveCore - the composition root of the platform.
 *
 * An agent is not a model; it is a configuration of cognitive primitives.
 * The core accepts one implementation per contract, wires them into a
 * perceive - recall - retrieve - reason - act - reflect loop, and exposes
 * a single `turn()` to the host application. Swap any binding (pgvector
 * to graph store, cloud LLM to on-device SLM, cloud STT to Whisper.cpp)
 * and the loop is untouched: developers write domain configuration, not
 * cognitive machinery.
 *
 * CK-10 (REFUENFO): profile.refusals enter Reason as deliberate() constraints.
 * When unresolvedConstraints intersects those refusals (violation or
 * cannot-evaluate), the loop takes the decline-and-explain path — never a
 * normal completion that ignored the flag (CK-10.1 / CK-10.3).
 *
 * 004: optional turn-stage spans + EventBus enrichment via
 * @moolam/observability (metadata only; privacy suite asserts no raw content).
 * Public turn() contract is unchanged.
 *
 * After reason (and only on the non-decline path), `runPlanStage`
 * compose/revise/reuse persists into `activePlans` and surfaces on
 * `AgentTurnOutput.plan`. Session PlanGate serializes overlapping turns.
 *
 * After first generate (respond), `runActStage` runs the tool
 * loop until a terminal finishReason; reflect only sees the terminal text.
 * Tool invokes go through the injectable policy hook (default: tools.invoke).
 * End-to-end coverage in tests/act_stage_integration.test.mjs.
 * Every act-stage invoke is gated by tool policy hooks.
 * Act stage passes AuditSink; awaits audit before effect.
 */

import type {
  ChatMessage,
  EventBusInterface,
  KnowledgeConnectorInterface,
  MemoryInterface,
  ModelInterface,
  Plan,
  PlanningInterface,
  ReasoningInterface,
  ReasoningResult,
  SpeechInterface,
  ToolInterface,
  VisionInterface,
} from "@moolam/contracts";
import {
  createTurnInstrumentation,
  getObservability,
  type TurnInstrumentation,
} from "@moolam/observability";
import {
  SessionPlanGate,
  defaultSessionGoals,
  planStageContext,
  runPlanStage,
  type PlanStageEvent,
} from "./plan_stage.js";
import {
  defaultToolInvokeHook,
  runActStage,
  type ToolInvokeHook,
  type ToolStageEvent,
} from "./tool_stage.js";
import {
  defaultDenyToolPolicyHooks,
  type ToolPolicy,
  type ToolPolicyEvent,
  type ToolPolicyHooks,
} from "./tool_policy.js";
import type { ToolAuditEvent, AuditSink } from "./tool_audit.js";

/** Bound scan of refusal / unresolved lists (NFR — no unbounded walks). */
export const REFUSAL_CONSTRAINT_SCAN_LIMIT = 64;

/** One implementation per cognitive primitive. Speech/vision are optional - text-only agents are valid. */
export interface CognitiveBindings {
  memory: MemoryInterface;
  model: ModelInterface;
  reasoning: ReasoningInterface;
  planning: PlanningInterface;
  tools: ToolInterface;
  knowledge: KnowledgeConnectorInterface;
  speech?: SpeechInterface;
  vision?: VisionInterface;
}

/** Domain persona: the ONLY thing most integrators need to author. */
export interface AgentProfile {
  /** e.g. "clinical-support", "legal-research", "mathematics-mentor". */
  domainId: string;
  /** System framing prepended to every model call. */
  charter: string;
  /** Hard boundaries the agent must refuse to cross (scope of practice). */
  refusals: string[];
  /** Default language(s), BCP-47. */
  languages: string[];
}

/**
 * Profile fields persisted on the durable session tier for rehydration.
 * Shape matches runtime-harness SessionProfileSnapshot (no package edge).
 */
export type DurableProfileSnapshot = {
  domainId: string;
  charter: string;
  refusals: string[];
  languages: string[];
};

/**
 * Project an {@link AgentProfile} into the durable-tier profile snapshot.
 * Refusals are bounded; charter is copied verbatim for resume (sovereign
 * locality — hosts must not echo this into cross-boundary telemetry).
 */
export function snapshotProfileForDurableSession(
  profile: AgentProfile,
): DurableProfileSnapshot {
  const refusals = Array.isArray(profile.refusals)
    ? profile.refusals
        .filter((r) => typeof r === "string")
        .slice(0, REFUSAL_CONSTRAINT_SCAN_LIMIT)
    : [];
  const languages = Array.isArray(profile.languages)
    ? profile.languages.filter((l) => typeof l === "string")
    : [];
  return {
    domainId: typeof profile.domainId === "string" ? profile.domainId.trim() : "",
    charter: typeof profile.charter === "string" ? profile.charter : "",
    refusals,
    languages,
  };
}

/**
 * Durable-tier seed for session resume (from runtime-harness rehydration).
 * Restores active plan without replaying historical turns.
 */
export type DurableSessionSeed = {
  subjectId: string;
  sessionId: string;
  activePlan: Plan | null;
  /** Correction-kind count retained on the durable tier (metadata only). */
  correctionCount?: number;
};

export type ApplyDurableSessionSeedAccepted = {
  ok: true;
  subjectId: string;
  sessionId: string;
  planRestored: boolean;
  /** Durable-tier resume never walks historical turn messages. */
  skippedHistoryReplay: true;
};

export type ApplyDurableSessionSeedRejected = {
  ok: false;
  failureClass: "missing_subject" | "missing_session" | "cross_subject";
  subjectId: string | null;
  sessionId: string | null;
  detail: string;
};

export type ApplyDurableSessionSeedResult =
  | ApplyDurableSessionSeedAccepted
  | ApplyDurableSessionSeedRejected;

/**
 * Map a rehydration seed surface into {@link DurableSessionSeed} for
 * {@link CognitiveCore.turn} / {@link CognitiveCore.applyDurableSessionSeed}.
 * Structural only — no dependency on runtime-harness types.
 */
export function durableSeedFromRehydration(input: {
  subjectId: string;
  sessionId: string;
  activePlan: Plan | null;
  correctionCount?: number;
}): DurableSessionSeed {
  return {
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    activePlan: input.activePlan,
    ...(input.correctionCount !== undefined
      ? { correctionCount: input.correctionCount }
      : {}),
  };
}

export interface AgentTurnInput {
  subjectId: string;
  sessionId: string;
  utterance: string;
  /** Optional visual attachment routed through VisionInterface when bound. */
  attachment?: { data: Uint8Array; mimeType: string };
  /**
   * Optional durable-tier seed (session rehydration). When set, restores
   * session plan before the turn loop — no N-turn history replay.
   */
  durableSeed?: DurableSessionSeed;
}

export interface AgentTurnOutput {
  reply: string;
  /** Citations from knowledge retrieval used in this turn. */
  citations: string[];
  /** The reasoning trace id persisted to memory for audit. */
  traceRef: string;
  /** Current plan snapshot, if a plan is active for this session. */
  plan: Plan | null;
  /**
   * True when the turn took the CK-10 decline path (refusal unresolved /
   * violated). Normal completions set this false.
   */
  declined: boolean;
  /**
   * Refusal category strings from {@link AgentProfile.refusals} that forced
   * the decline. Empty on normal completions. Never includes the charter.
   */
  refusalCategories: readonly string[];
}

/** Structured turn observability — never includes raw learner utterance text. */
export type CognitiveCoreTurnEvent = {
  event: "cognitive_core.turn";
  subjectId: string;
  sessionId: string;
  domainId: string;
  outcome: "completed" | "declined" | "error";
  refusalCategoryCount: number;
};

/** Turn + plan/act/policy/audit telemetry union (metadata only). */
export type CognitiveCoreEmitEvent =
  | CognitiveCoreTurnEvent
  | PlanStageEvent
  | ToolStageEvent
  | ToolPolicyEvent
  | ToolAuditEvent;

export type CognitiveCoreOptions = {
  /** Optional structured emitter (tests / hosts). */
  emit?: (event: CognitiveCoreEmitEvent) => void;
  /**
   * Optional turn-stage instrumentation. Defaults to
   * {@link createTurnInstrumentation}(`getObservability()`, { eventBus }) so
   * hosts that called `initObservability()` before constructing CognitiveCore
   * get spans without changing the public `turn()` contract.
   */
  turnInstrumentation?: TurnInstrumentation;
  /**
   * Optional runtime EventBus. When set (and turnInstrumentation is default),
   * Stage start/end events are published and enrich active spans .
   */
  eventBus?: EventBusInterface;
  /**
   * Post-policy effect path for act-stage. Called only after risk policy allows.
   * Defaults to tools.invoke.
   */
  toolInvokeHook?: ToolInvokeHook;
  /**
   * Risk-policy hooks or ToolPolicy . Defaults to deny-by-default
   * for write/critical without host approval hooks.
   */
  toolPolicy?: ToolPolicy | ToolPolicyHooks;
  /**
   * Write-ahead AuditSink for act-stage . When omitted, act
   * stage installs a per-turn in-memory sink. Pass `null` only for defect tests.
   */
  toolAuditSink?: AuditSink | null;
};

/**
 * Intersection of profile refusals with Reason's unresolved list.
 * Conservative: any overlapping refusal → decline (cannot-evaluate or violated).
 */
export function unresolvedRefusalCategories(
  profileRefusals: readonly string[],
  unresolvedConstraints: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(unresolvedConstraints) || profileRefusals.length === 0) {
    return [];
  }
  const unresolved = new Set(
    unresolvedConstraints
      .slice(0, REFUSAL_CONSTRAINT_SCAN_LIMIT)
      .map((c) => c.trim())
      .filter(Boolean),
  );
  const hits: string[] = [];
  const limit = Math.min(profileRefusals.length, REFUSAL_CONSTRAINT_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const refusal = profileRefusals[i]!.trim();
    if (refusal && unresolved.has(refusal)) {
      hits.push(refusal);
    }
  }
  return hits;
}

/**
 * Decline-and-explain reply. Names refusal categories only — never the
 * charter / system prompt.
 */
export function formatDeclineReply(
  categories: readonly string[],
  reasoning: Pick<ReasoningResult, "conclusion">,
): string {
  const named =
    categories.length === 0
      ? "scope of practice"
      : categories.join("; ");
  const rationale =
    typeof reasoning.conclusion === "string" &&
    reasoning.conclusion.trim().length > 0
      ? reasoning.conclusion.trim().slice(0, 280)
      : "This request could not be cleared against my refusal constraints.";
  return (
    `I must decline this request. It is outside my scope of practice ` +
    `regarding: ${named}. ${rationale}`
  );
}

/**
 * Reference composition. The loop is deliberately explicit and linear so
 * integrators can read it top-to-bottom; specialized deployments may
 * subclass or replace it while keeping the bindings contract.
 */
export class CognitiveCore {
  private readonly activePlans = new Map<string, Plan>();
  private readonly planGate = new SessionPlanGate();
  private readonly emit: ((event: CognitiveCoreEmitEvent) => void) | undefined;
  private readonly toolInvokeHook: ToolInvokeHook;
  private readonly toolPolicyHooks: ToolPolicyHooks;
  private readonly toolAuditSink: AuditSink | null | undefined;
  private readonly instrumentation: TurnInstrumentation;

  constructor(
    private readonly profile: AgentProfile,
    private readonly bindings: CognitiveBindings,
    options?: CognitiveCoreOptions,
  ) {
    this.emit = options?.emit;
    this.toolInvokeHook = options?.toolInvokeHook ?? defaultToolInvokeHook;
    const policyOpt = options?.toolPolicy;
    if (policyOpt === undefined) {
      this.toolPolicyHooks = defaultDenyToolPolicyHooks;
    } else if (
      typeof (policyOpt as ToolPolicy).authorize === "function" &&
      "hooks" in policyOpt
    ) {
      this.toolPolicyHooks = (policyOpt as ToolPolicy).hooks;
    } else {
      this.toolPolicyHooks = policyOpt as ToolPolicyHooks;
    }
    this.toolAuditSink = options?.toolAuditSink;
    this.instrumentation =
      options?.turnInstrumentation ??
      createTurnInstrumentation(
        getObservability(),
        options?.eventBus !== undefined ? { eventBus: options.eventBus } : {},
      );
  }

  /**
   * Restore durable-tier plan into the in-memory session map.
   * Cross-subject seeds are rejected. Does not replay historical turns.
   */
  applyDurableSessionSeed(
    seed: DurableSessionSeed,
  ): ApplyDurableSessionSeedResult {
    const subjectId =
      typeof seed?.subjectId === "string" ? seed.subjectId.trim() : "";
    const sessionId =
      typeof seed?.sessionId === "string" ? seed.sessionId.trim() : "";
    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        sessionId: sessionId || null,
        detail: "durableSeed.subjectId required",
      };
    }
    if (!sessionId) {
      return {
        ok: false,
        failureClass: "missing_session",
        subjectId,
        sessionId: null,
        detail: "durableSeed.sessionId required",
      };
    }
    if (seed.activePlan !== null && seed.activePlan !== undefined) {
      this.activePlans.set(sessionId, seed.activePlan);
    } else {
      this.activePlans.delete(sessionId);
    }
    return {
      ok: true,
      subjectId,
      sessionId,
      planRestored: seed.activePlan != null,
      skippedHistoryReplay: true,
    };
  }

  /** Active plan for a session, if any (tests / hosts). */
  getActivePlan(sessionId: string): Plan | null {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!id) return null;
    return this.activePlans.get(id) ?? null;
  }

  /**
   * One full cognitive turn: perceive - recall - retrieve - reason - plan -
   * respond/act - reflect. Plan runs only after reasoning and only when the
   * decline path is not taken. Act runs inside respond after first generate
   * Until a terminal finishReason .
   */
  async turn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const b = this.bindings;
    const subjectId = input.subjectId.trim();
    if (!subjectId) {
      throw new Error("AgentTurnInput.subjectId is required (subject isolation)");
    }
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      throw new Error("AgentTurnInput.sessionId is required");
    }

    if (input.durableSeed !== undefined) {
      const seedSubject =
        typeof input.durableSeed.subjectId === "string"
          ? input.durableSeed.subjectId.trim()
          : "";
      if (seedSubject !== subjectId) {
        throw new Error(
          "AgentTurnInput.durableSeed.subjectId must match turn subjectId",
        );
      }
      const seedSession =
        typeof input.durableSeed.sessionId === "string"
          ? input.durableSeed.sessionId.trim()
          : "";
      if (seedSession !== sessionId) {
        throw new Error(
          "AgentTurnInput.durableSeed.sessionId must match turn sessionId",
        );
      }
      const applied = this.applyDurableSessionSeed(input.durableSeed);
      if (!applied.ok) {
        throw new Error(applied.detail);
      }
    }

    const spanAttrs = {
      subjectId,
      sessionId,
    };

    return this.instrumentation.withTurn(spanAttrs, async (stages) => {
      // 1. Perceive: fold visual input into the textual working context.
      //    Speech is unbound in the text loop — no speech placeholder span.
      let perception = input.utterance;
      await stages.run("perceive", async () => {
        if (input.attachment && b.vision) {
          const visual = await b.vision.analyze({
            input: input.attachment,
            instruction: `Describe this input in the context of: ${input.utterance}`,
          });
          perception += `\n[visual context] ${visual.answer}`;
        }
      });

      // 2. Recall: what do we know about this principal?
      const memories = await stages.run("recall", () =>
        b.memory.recall({
          subjectId,
          query: perception,
          limit: 6,
        }),
      );

      // 3. Retrieve: what does the authoritative corpus say?
      const passages = await stages.run("retrieve", () =>
        b.knowledge.retrieve({ query: perception, limit: 6 }),
      );

      // 4. Reason: deliberate over evidence with an auditable trace.
      //    Profile refusals enter as constraints (CK-10).
      const reasoning = await stages.run("reason", () =>
        b.reasoning.deliberate({
          proposition: perception,
          evidence: [
            ...memories.map((m) => ({
              sourceRef: `memory:${m.item.id}`,
              content: m.item.text,
            })),
            ...passages.map((p) => ({
              sourceRef: p.citation,
              content: p.content,
              confidence: p.score,
            })),
          ],
          constraints: this.profile.refusals,
          effort: "standard",
        }),
      );

      const refusalHits = unresolvedRefusalCategories(
        this.profile.refusals,
        reasoning.unresolvedConstraints,
      );

      // 5a. Decline path — omit respond span (model.generate never runs).
      if (refusalHits.length > 0) {
        return stages.run("reflect", async () => {
          const reply = formatDeclineReply(refusalHits, reasoning);
          const trace = await b.memory.remember({
            subjectId,
            topicId: this.profile.domainId,
            text: `DECLINE: categories=[${refusalHits.join("|")}]\nRationale: ${reasoning.conclusion}`,
            kind: "episodic",
            createdAt: new Date().toISOString(),
            metadata: {
              sessionId,
              outcome: "declined",
              refusalCount: refusalHits.length,
            },
          });
          this.emit?.({
            event: "cognitive_core.turn",
            subjectId,
            sessionId,
            domainId: this.profile.domainId,
            outcome: "declined",
            refusalCategoryCount: refusalHits.length,
          });
          return {
            reply,
            citations: [],
            traceRef: trace.id,
            plan: this.activePlans.get(sessionId) ?? null,
            declined: true,
            refusalCategories: refusalHits,
          };
        });
      }

      // 5b. Plan: compose on first session turn; revise on blocking signals;
      // Otherwise reuse. Serialize per sessionId .
      const planSnapshot = await this.planGate.runExclusive(sessionId, async () => {
        const staged = await runPlanStage({
          subjectId,
          sessionId,
          planning: b.planning,
          reasoning,
          activePlan: this.activePlans.get(sessionId) ?? null,
          goals: defaultSessionGoals(this.profile.domainId, subjectId),
          context: planStageContext(this.profile.domainId, reasoning),
          ...(this.emit ? { emit: this.emit } : {}),
        });
        if (staged.outcome === "composed" || staged.outcome === "revised") {
          this.activePlans.set(sessionId, staged.plan);
        }
        return staged.plan;
      });

      // 5c. Respond + act: first generate, then tool loop until terminal
      // FinishReason . Reflect only after the terminal text.
      const acted = await stages.run("respond", async () => {
        const messages: ChatMessage[] = [
          { role: "system", content: this.profile.charter },
          {
            role: "system",
            content: `Grounded conclusion (cite when used): ${reasoning.conclusion}`,
          },
          { role: "user", content: perception },
        ];
        const first = await b.model.generate(messages, { deadlineMs: 30_000 });
        return runActStage({
          subjectId,
          sessionId,
          model: b.model,
          tools: b.tools,
          messages,
          generation: first,
          generateOptions: { deadlineMs: 30_000 },
          policyHooks: this.toolPolicyHooks,
          invokeHook: this.toolInvokeHook,
          ...(this.toolAuditSink !== undefined
            ? { auditSink: this.toolAuditSink }
            : {}),
          ...(this.emit ? { emit: this.emit } : {}),
        });
      });

      // 6. Reflect: persist the episode so the agent adapts long-term.
      return stages.run("reflect", async () => {
        const trace = await b.memory.remember({
          subjectId,
          topicId: this.profile.domainId,
          text: `Q: ${input.utterance}\nConclusion: ${reasoning.conclusion}`,
          kind: "episodic",
          createdAt: new Date().toISOString(),
          metadata: {
            sessionId,
            confidence: reasoning.confidence,
            outcome: "completed",
            toolIterations: acted.iterations,
            toolInvocations: acted.toolInvocations,
          },
        });

        this.emit?.({
          event: "cognitive_core.turn",
          subjectId,
          sessionId,
          domainId: this.profile.domainId,
          outcome: "completed",
          refusalCategoryCount: 0,
        });

        return {
          reply: acted.generation.text,
          citations: passages.map((p) => p.citation),
          traceRef: trace.id,
          plan: planSnapshot,
          declined: false,
          refusalCategories: [],
        };
      });
    });
  }
}
