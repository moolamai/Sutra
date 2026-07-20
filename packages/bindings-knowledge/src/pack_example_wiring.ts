/**
 * Wire PackKnowledgeConnector into CognitiveCore (teacher-basic example path).
 *
 * Proves the teacher CBSE slice pack loads as data (no domains/ import) and
 * grounds a CognitiveCore turn with resolvable citations under network deny.
 */

import path from "node:path";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  assertLocality,
  withEgressRecordingTurn,
} from "@moolam/contract-conformance";
import { CognitiveCore, type AgentProfile } from "@moolam/cognitive-core";
import {
  makeMemory,
  makeModel,
  makeNoTools,
  makePlanning,
  makeReasoning,
} from "@moolam/contract-mocks";
import {
  loadTeacherCbseSliceConnector,
  resolveTeacherCbseSlicePackRoot,
  TEACHER_CBSE_SLICE_PACK_ID,
  TEACHER_CBSE_SLICE_PACK_RELPATH,
  type PackLoaderTelemetry,
} from "./pack_loader.js";
import type { PackFormatTelemetry } from "./pack_format.js";

export type TeacherPackWiringTelemetry = {
  event: "bindings_knowledge.teacher_pack_wiring";
  outcome:
    | "start"
    | "pass"
    | "fail"
    | "egress_fail"
    | "domains_import_fail"
    | "citation_fail";
  subjectId: string;
  deviceId: string;
  packId?: string;
  detail?: string;
};

type WiringTelemetry =
  | TeacherPackWiringTelemetry
  | PackLoaderTelemetry
  | PackFormatTelemetry;

export type ProveTeacherPackCognitiveCoreOptions = {
  subjectId?: string;
  deviceId?: string;
  sessionId?: string;
  utterance?: string;
  nowMs?: number;
  packRoot?: string;
  onTelemetry?: (e: WiringTelemetry) => void;
};

export type ProveTeacherPackCognitiveCoreResult = {
  ok: boolean;
  subjectId: string;
  deviceId: string;
  packId: string;
  packRoot: string;
  locality: string;
  asOf: string;
  citationCount: number;
  citations: string[];
  egressAttemptCount: number;
  localityOk: boolean;
  domainsImportFree: boolean;
  failures: string[];
};

const DEFAULT_TEACHER_UTTERANCE =
  "I do not understand why 3:4 and 6:8 are the same ratio.";

const TEACHER_PROFILE: AgentProfile = {
  domainId: "education-mathematics",
  charter:
    "You are a patient mathematics mentor. Diagnose gaps before explaining. Prefer questions over answers when the subject is close.",
  refusals: ["Never complete graded assessments on the subject's behalf."],
  languages: ["en-IN", "hi-IN"],
};

function emit(
  onTelemetry: ((e: WiringTelemetry) => void) | undefined,
  partial: Omit<TeacherPackWiringTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_knowledge.teacher_pack_wiring",
    ...partial,
  });
}

/**
 * True when the resolved pack root is under knowledge-packs/ and not domains/.
 */
export function assertPackIsDataNotDomainImport(packRoot: string): boolean {
  const normalized = path.resolve(packRoot).replace(/\\/g, "/");
  const underKnowledgePacks = normalized.includes("/knowledge-packs/");
  const underDomains = normalized.includes("/domains/");
  return underKnowledgePacks && !underDomains;
}

/**
 * CognitiveCore turn grounded by knowledge-packs/teacher-cbse-slice/
 * under B1 egress deny (no network, no domains/ import).
 */
export async function proveTeacherPackCognitiveCore(
  options: ProveTeacherPackCognitiveCoreOptions = {},
): Promise<ProveTeacherPackCognitiveCoreResult> {
  const subjectId = options.subjectId?.trim() || "subj.teacher.pack";
  const deviceId = options.deviceId?.trim() || "dev-teacher-pack";
  const sessionId = options.sessionId?.trim() || "session.teacher.pack";
  const utterance = options.utterance?.trim() || DEFAULT_TEACHER_UTTERANCE;
  const nowMs = options.nowMs ?? Date.parse("2026-07-15T00:00:00.000Z");
  const packRoot =
    options.packRoot ?? resolveTeacherCbseSlicePackRoot();
  const failures: string[] = [];

  emit(options.onTelemetry, { outcome: "start", subjectId, deviceId });

  let packId = "";
  let locality = "";
  let asOf = "";
  let citations: string[] = [];
  let egressAttemptCount = 0;
  let localityOk = false;
  const domainsImportFree = assertPackIsDataNotDomainImport(packRoot);
  if (!domainsImportFree) {
    failures.push(
      `pack root must live under knowledge-packs/ (not domains/): ${packRoot}`,
    );
    emit(options.onTelemetry, {
      outcome: "domains_import_fail",
      subjectId,
      deviceId,
      detail: packRoot,
    });
  }

  try {
    const { turn } = await withEgressRecordingTurn(
      {
        subjectId,
        deviceId,
        caller: { principalId: "principal.teacher.pack", subjectScope: "*" },
      },
      async () => {
        const knowledge = loadTeacherCbseSliceConnector({
          packRoot,
          subjectId,
          deviceId,
          nowMs,
          ...(options.onTelemetry !== undefined
            ? { onTelemetry: options.onTelemetry }
            : {}),
        });
        const desc = knowledge.describe();
        packId = desc.packId ?? knowledge.packId;
        locality = desc.locality;
        asOf = desc.asOf;

        if (packId !== TEACHER_CBSE_SLICE_PACK_ID) {
          failures.push(
            `expected packId ${TEACHER_CBSE_SLICE_PACK_ID}, got ${packId}`,
          );
        }
        if (desc.locality !== "bundled-offline") {
          failures.push(`expected bundled-offline, got ${desc.locality}`);
        }

        const core = new CognitiveCore(TEACHER_PROFILE, {
          memory: makeMemory(),
          model: makeModel("mentor"),
          reasoning: makeReasoning(),
          planning: makePlanning(),
          tools: makeNoTools(),
          knowledge,
        });

        const out = await core.turn({
          subjectId,
          sessionId,
          utterance,
        });
        citations = [...out.citations];

        if (!citations.length) {
          failures.push("CognitiveCore turn returned no grounded citations");
          emit(options.onTelemetry, {
            outcome: "citation_fail",
            subjectId,
            deviceId,
            packId,
          });
        }

        const known = new Set(desc.sources.map((s) => s.sourceId));
        // Citations are locator strings; also verify retrieve still resolves sources.
        const passages = await knowledge.retrieve({
          query: utterance,
          limit: 6,
        });
        for (const p of passages) {
          if (!p.citation.trim() || !known.has(p.sourceId)) {
            failures.push(
              `retrieve passage sourceId=${p.sourceId} not in describe().sources`,
            );
            break;
          }
        }

        return { citationCount: citations.length };
      },
    );

    egressAttemptCount = turn.attempts.length;
    const asserted = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
    localityOk = asserted.ok === true && turn.noEgress === true;
    if (!localityOk) {
      failures.push(
        `locality breach: attempts=${egressAttemptCount} ok=${asserted.ok}`,
      );
      emit(options.onTelemetry, {
        outcome: "egress_fail",
        subjectId,
        deviceId,
        packId,
        detail: `egress=${egressAttemptCount}`,
      });
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }

  const ok =
    failures.length === 0 &&
    domainsImportFree &&
    localityOk &&
    citations.length > 0;

  emit(options.onTelemetry, {
    outcome: ok ? "pass" : "fail",
    subjectId,
    deviceId,
    ...(packId ? { packId } : {}),
    ...(ok ? {} : { detail: failures[0] }),
  });

  return {
    ok,
    subjectId,
    deviceId,
    packId,
    packRoot,
    locality,
    asOf,
    citationCount: citations.length,
    citations,
    egressAttemptCount,
    localityOk,
    domainsImportFree,
    failures,
  };
}

export { TEACHER_CBSE_SLICE_PACK_RELPATH, TEACHER_CBSE_SLICE_PACK_ID };

