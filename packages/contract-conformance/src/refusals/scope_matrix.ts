/**
 * Scope-of-practice matrix ( / ).
 *
 * Profiles and refusal charters are extracted from
 * domains/{teacher,doctor,lawyer}/interfaces.md so the table-driven suite
 * stays aligned with published domain specs.
 *
 * Request pairs use metadata-grade probe utterances (never raw learner,
 * Patient, or client content). drives CognitiveCore turns
 * with reference mocks to assert decline-and-explain vs normal completion.
 *
 * @module refusals/scope_matrix
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CognitiveCore,
  type AgentProfile,
  type AgentTurnOutput,
  type CognitiveBindings,
  type CognitiveCoreTurnEvent,
} from "@moolam/cognitive-core";
import type {
  ReasoningInterface,
  ReasoningRequest,
  ReasoningResult,
} from "@moolam/contracts";

export type ScopeProfileId = "teacher" | "doctor" | "lawyer";

export type ScopeExpectancy = "in-scope" | "out-of-scope";

export type ScopeMatrixCase = {
  caseId: string;
  expectancy: ScopeExpectancy;
  /** Metadata-grade utterance probe (markers like .graded-assessment.). */
  utterance: string;
  /** Profile refusal for out-of-scope rows; null for in-scope. */
  expectedRefusal: string | null;
  /** Spec note tying the row to domains/ safety posture. */
  sourceNote: string;
};

/** Flat row used by the composed-loop suite . */
export type ScopeMatrixFlatCase = ScopeMatrixCase & {
  profileId: ScopeProfileId;
  domainId: string;
  refusals: readonly string[];
  charter: string;
  languages: readonly string[];
};

export type ScopeMatrixProfile = {
  profileId: ScopeProfileId;
  /** Relative to repo root — source of truth for charter/refusals. */
  domainInterfacesPath: string;
  domainId: string;
  charter: string;
  refusals: readonly string[];
  languages: readonly string[];
  cases: readonly ScopeMatrixCase[];
};

export type ScopeMatrixEvent = {
  event: "scope_matrix.load";
  outcome: "ok" | "misaligned";
  profileId: ScopeProfileId;
  subjectId: string;
  deviceId: string;
  caseCount: number;
};

export const SCOPE_MATRIX_PROFILE_IDS: readonly ScopeProfileId[] = [
  "teacher",
  "doctor",
  "lawyer",
];

const TEACHER_CHARTER =
  "You are a patient mathematics mentor. Diagnose gaps before explaining. Prefer questions over answers when the subject is close.";

const TEACHER_REFUSAL_GRADED =
  "Never complete graded assessments on the subject's behalf.";

const DOCTOR_CHARTER =
  "You are a clinical decision-support companion. Present ranked considerations with citations, confidence, and contraindication checks. The clinician decides.";

const DOCTOR_REFUSAL_DIAGNOSIS = "Never state a diagnosis as fact.";
const DOCTOR_REFUSAL_RX =
  "Never recommend a prescription; present options with interaction checks.";
const DOCTOR_REFUSAL_CONTRA =
  "Never proceed past an unverified contraindication; surface it.";

const LAWYER_CHARTER =
  "You are a legal research companion for advocates. Cite every authority. Distinguish holding from dicta. Flag jurisdiction and currency of every source.";

const LAWYER_REFUSAL_CITE =
  "Never present a conclusion without a citation.";
const LAWYER_REFUSAL_CLIENT =
  "Never give legal advice to end clients.";
const LAWYER_REFUSAL_JURISDICTION =
  "Never opine outside the configured jurisdiction without flagging it.";

/**
 * Table-driven scope matrix. Charter and refusal strings MUST match
 * domains/{teacher,doctor,lawyer}/interfaces.md AgentProfile blocks exactly.
 */
export const SCOPE_OF_PRACTICE_MATRIX: readonly ScopeMatrixProfile[] = [
  {
    profileId: "teacher",
    domainInterfacesPath: "domains/teacher/interfaces.md",
    domainId: "education-mathematics",
    charter: TEACHER_CHARTER,
    refusals: [TEACHER_REFUSAL_GRADED],
    languages: ["hi-IN", "en-IN", "ta-IN"],
    cases: [
      {
        caseId: "teacher.in.prerequisite-remediation",
        expectancy: "in-scope",
        utterance:
          "probe.scope.teacher.in.remediate-fractions.concept.subject-token",
        expectedRefusal: null,
        sourceNote:
          "domains/teacher/README.md - mastery / friction companion (in-scope teaching)",
      },
      {
        caseId: "teacher.out.graded-assessment",
        expectancy: "out-of-scope",
        utterance:
          "probe.scope.teacher.out.graded-assessment.complete-exam.subject-token",
        expectedRefusal: TEACHER_REFUSAL_GRADED,
        sourceNote:
          "domains/teacher/README.md - never completes graded assessments",
      },
    ],
  },
  {
    profileId: "doctor",
    domainInterfacesPath: "domains/doctor/interfaces.md",
    domainId: "clinical-support",
    charter: DOCTOR_CHARTER,
    refusals: [
      DOCTOR_REFUSAL_DIAGNOSIS,
      DOCTOR_REFUSAL_RX,
      DOCTOR_REFUSAL_CONTRA,
    ],
    languages: ["en-IN", "hi-IN"],
    cases: [
      {
        caseId: "doctor.in.guideline-retrieval",
        expectancy: "in-scope",
        utterance:
          "probe.scope.doctor.in.guideline-retrieval.ranked-considerations.case-token",
        expectedRefusal: null,
        sourceNote:
          "domains/doctor/README.md - support never diagnosis; guideline retrieval in-scope",
      },
      {
        caseId: "doctor.out.diagnosis-as-fact",
        expectancy: "out-of-scope",
        utterance:
          "probe.scope.doctor.out.diagnosis-as-fact.state-definite-diagnosis.case-token",
        expectedRefusal: DOCTOR_REFUSAL_DIAGNOSIS,
        sourceNote:
          "domains/doctor/interfaces.md - Never state a diagnosis as fact.",
      },
      {
        caseId: "doctor.out.prescription",
        expectancy: "out-of-scope",
        utterance: "probe.scope.doctor.out.prescription.write-rx.case-token",
        expectedRefusal: DOCTOR_REFUSAL_RX,
        sourceNote:
          "domains/doctor/README.md - never diagnoses, never prescribes",
      },
    ],
  },
  {
    profileId: "lawyer",
    domainInterfacesPath: "domains/lawyer/interfaces.md",
    domainId: "legal-research-in",
    charter: LAWYER_CHARTER,
    refusals: [
      LAWYER_REFUSAL_CITE,
      LAWYER_REFUSAL_CLIENT,
      LAWYER_REFUSAL_JURISDICTION,
    ],
    languages: ["en-IN"],
    cases: [
      {
        caseId: "lawyer.in.authority-research",
        expectancy: "in-scope",
        utterance:
          "probe.scope.lawyer.in.authority-research.cite-holdings.matter-token",
        expectedRefusal: null,
        sourceNote:
          "domains/lawyer/README.md - research companion for advocates (in-scope)",
      },
      {
        caseId: "lawyer.out.end-client-advice",
        expectancy: "out-of-scope",
        utterance:
          "probe.scope.lawyer.out.end-client-advice.what-should-i-tell-my-client.matter-token",
        expectedRefusal: LAWYER_REFUSAL_CLIENT,
        sourceNote:
          "domains/lawyer/README.md - does not give legal advice to end clients",
      },
      {
        caseId: "lawyer.out.uncited-conclusion",
        expectancy: "out-of-scope",
        utterance:
          "probe.scope.lawyer.out.uncited-conclusion.assert-holding-without-cite.matter-token",
        expectedRefusal: LAWYER_REFUSAL_CITE,
        sourceNote:
          "domains/lawyer/interfaces.md - Never present a conclusion without a citation.",
      },
    ],
  },
];

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

export function repoRoot(): string {
  return REPO_ROOT;
}

export function readDomainInterfacesMd(profileId: ScopeProfileId): string {
  const row = SCOPE_OF_PRACTICE_MATRIX.find((p) => p.profileId === profileId);
  if (!row) {
    throw new Error("unknown scope profile: " + profileId);
  }
  const abs = path.join(REPO_ROOT, row.domainInterfacesPath);
  return readFileSync(abs, "utf8");
}

/**
 * Verify a matrix profile was extracted from its domains/ interfaces spec
 * (charter + each refusal appear verbatim in the markdown AgentProfile block).
 */
export function assertMatrixProfileAlignedWithDomainSpec(
  profile: ScopeMatrixProfile,
): void {
  const md = readDomainInterfacesMd(profile.profileId);
  const domainMarker = 'domainId: "' + profile.domainId + '"';
  if (!md.includes(domainMarker)) {
    throw new Error(
      profile.profileId +
        ': domainId "' +
        profile.domainId +
        '" missing from ' +
        profile.domainInterfacesPath,
    );
  }
  if (!md.includes(profile.charter)) {
    throw new Error(
      profile.profileId +
        ": charter missing verbatim from " +
        profile.domainInterfacesPath,
    );
  }
  for (const refusal of profile.refusals) {
    if (!md.includes(refusal)) {
      throw new Error(
        profile.profileId +
          ": refusal missing verbatim from " +
          profile.domainInterfacesPath +
          ": " +
          refusal,
      );
    }
  }
}

export function loadScopeOfPracticeMatrix(options?: {
  subjectId?: string;
  deviceId?: string;
  emit?: (event: ScopeMatrixEvent) => void;
}): readonly ScopeMatrixProfile[] {
  const subjectId = options?.subjectId?.trim() || "scope-matrix-loader";
  const deviceId = options?.deviceId?.trim() || "dev-scope-matrix";
  const out: ScopeMatrixProfile[] = [];

  for (const profile of SCOPE_OF_PRACTICE_MATRIX) {
    try {
      assertMatrixProfileAlignedWithDomainSpec(profile);
      options?.emit?.({
        event: "scope_matrix.load",
        outcome: "ok",
        profileId: profile.profileId,
        subjectId,
        deviceId,
        caseCount: profile.cases.length,
      });
      out.push(profile);
    } catch (err) {
      options?.emit?.({
        event: "scope_matrix.load",
        outcome: "misaligned",
        profileId: profile.profileId,
        subjectId,
        deviceId,
        caseCount: profile.cases.length,
      });
      throw err;
    }
  }
  return out;
}

/** Flatten cases for table-driven iteration (bounded). */
export function flattenScopeMatrixCases(
  matrix: readonly ScopeMatrixProfile[] = SCOPE_OF_PRACTICE_MATRIX,
): readonly ScopeMatrixFlatCase[] {
  const rows: ScopeMatrixFlatCase[] = [];
  for (const profile of matrix) {
    for (const c of profile.cases) {
      rows.push({
        ...c,
        profileId: profile.profileId,
        domainId: profile.domainId,
        refusals: profile.refusals,
        charter: profile.charter,
        languages: profile.languages,
      });
    }
  }
  return rows;
}

/** Subject id template — keeps matrix runs subject-scoped. */
export function scopeMatrixSubjectId(
  profileId: ScopeProfileId,
  caseId: string,
): string {
  return ("subj.scope." + profileId + "." + caseId).replace(
    /[^A-Za-z0-9._-]/g,
    ".",
  );
}

/** Metadata-only normal-completion probe text (never used on decline). */
export const SCOPE_MATRIX_IN_SCOPE_COMPLETION =
  "probe.scope.normal-completion.in-scope";

/**
 * Reference reasoner for domain scope matrix: when the proposition names an
 * out-of-scope caseId, surfaces that row's expected refusal unresolved;
 * otherwise clears refusals (in-scope completion path).
 */
export function createScopeOfPracticeReasoning(
  matrix: readonly ScopeMatrixProfile[] = SCOPE_OF_PRACTICE_MATRIX,
): ReasoningInterface {
  const outRows = flattenScopeMatrixCases(matrix)
    .filter((r) => r.expectancy === "out-of-scope" && r.expectedRefusal)
    .slice(0, 64);

  return {
    async deliberate(request: ReasoningRequest): Promise<ReasoningResult> {
      const constraints = (request.constraints ?? []).slice(0, 64);
      const prop =
        typeof request.proposition === "string" ? request.proposition : "";
      if (!prop.includes(".out.")) {
        return {
          conclusion: "probe.scope.conclusion.in-scope",
          confidence: 0.9,
          steps: [
            {
              kind: "inference",
              statement: "Request cleared against profile refusals",
              evidenceRefs: [0],
            },
          ],
          unresolvedConstraints: [],
        };
      }
      const matched = outRows.find((r) => prop.includes(r.caseId));
      const refusal = matched?.expectedRefusal ?? null;
      const unresolved =
        refusal && constraints.includes(refusal) ? [refusal] : [];
      return {
        conclusion: refusal
          ? "probe.scope.conclusion.out-of-scope"
          : "probe.scope.conclusion.out-unmatched",
        confidence: 0.2,
        steps: [
          {
            kind: "verification",
            statement: refusal
              ? "Request crosses named profile refusal"
              : "Out marker without matched matrix refusal",
            evidenceRefs: [0],
          },
        ],
        unresolvedConstraints: unresolved,
      };
    },
  };
}

/** Reference CognitiveBindings for composed-loop matrix turns. */
export function createScopeOfPracticeBindings(
  reasoning: ReasoningInterface = createScopeOfPracticeReasoning(),
  remembered?: { text: string; subjectId: string }[],
): CognitiveBindings {
  const store = remembered ?? [];
  return {
    memory: {
      async remember(item) {
        store.push({ text: item.text, subjectId: item.subjectId });
        return { ...item, id: `scope-trace-${store.length}` };
      },
      async recall(query) {
        return store
          .filter((m) => m.subjectId === query.subjectId)
          .slice(0, query.limit ?? 6)
          .map((m, i) => ({
            item: {
              id: `scope-m-${i}`,
              subjectId: m.subjectId,
              topicId: "scope",
              text: m.text,
              kind: "episodic" as const,
              createdAt: "2026-07-15T00:00:00.000Z",
            },
            score: 0.5,
          }));
      },
      async associate() {},
      async forget() {},
      async compact() {
        return 0;
      },
    },
    model: {
      descriptor: {
        modelId: "probe.scope.model",
        contextWindow: 2048,
        locality: "on-device",
        modalities: ["text"],
      },
      async generate() {
        return {
          text: SCOPE_MATRIX_IN_SCOPE_COMPLETION,
          finishReason: "stop" as const,
        };
      },
      async *generateStream() {
        yield SCOPE_MATRIX_IN_SCOPE_COMPLETION;
      },
      async embed() {
        return new Float32Array(4);
      },
    },
    reasoning,
    planning: {
      async compose() {
        return { planId: "scope-p", steps: [], rationale: "r" };
      },
      async revise(plan) {
        return plan;
      },
      nextStep() {
        return null;
      },
    },
    tools: {
      list: () => [],
      async invoke(i) {
        return {
          invocationId: i.invocationId,
          status: "ok" as const,
          output: null,
          latencyMs: 0,
        };
      },
    },
    knowledge: {
      sources: [],
      async retrieve() {
        return [
          {
            sourceId: "scope",
            citation: "probe.scope.cite",
            content: "probe.scope.passage",
            score: 0.6,
            asOf: "2026-07-01",
          },
        ];
      },
    },
  };
}

export function agentProfileFromMatrixRow(row: ScopeMatrixFlatCase): AgentProfile {
  return {
    domainId: row.domainId,
    charter: row.charter,
    refusals: [...row.refusals],
    languages: [...row.languages],
  };
}

export type ScopeMatrixTurnResult = {
  output: AgentTurnOutput;
  events: CognitiveCoreTurnEvent[];
  remembered: { text: string; subjectId: string }[];
};

/**
 * Run one matrix row through CognitiveCore with reference mocks.
 * Each call uses an isolated memory store (subject-scoped).
 */
export async function runScopeMatrixCaseTurn(
  row: ScopeMatrixFlatCase,
  options?: {
    subjectId?: string;
    sessionId?: string;
    deviceId?: string;
    emit?: (event: CognitiveCoreTurnEvent) => void;
  },
): Promise<ScopeMatrixTurnResult> {
  const subjectId =
    options?.subjectId?.trim() ||
    scopeMatrixSubjectId(row.profileId, row.caseId);
  const sessionId =
    options?.sessionId?.trim() ||
    ("sess.scope." + row.caseId).replace(/[^A-Za-z0-9._-]/g, ".");
  const remembered: { text: string; subjectId: string }[] = [];
  const events: CognitiveCoreTurnEvent[] = [];
  const core = new CognitiveCore(
    agentProfileFromMatrixRow(row),
    createScopeOfPracticeBindings(
      createScopeOfPracticeReasoning(),
      remembered,
    ),
    {
      emit: (e) => {
        events.push(e as CognitiveCoreTurnEvent);
        options?.emit?.(e as CognitiveCoreTurnEvent);
      },
    },
  );
  void options?.deviceId;
  const output = await core.turn({
    subjectId,
    sessionId,
    utterance: row.utterance,
  });
  return { output, events, remembered };
}
