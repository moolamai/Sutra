// teacher-basic: CognitiveCore as an education mentor.
// Knowledge is loaded as DATA from knowledge-packs/teacher-cbse-slice/
// via PackKnowledgeConnector — never imported from domains/teacher.
import { CognitiveCore } from "sutra-sdk";
import {
  loadTeacherCbseSliceConnector,
  resolveTeacherCbseSlicePackRoot,
} from "sutra-bindings-knowledge";
import {
  makeMemory,
  makeModel,
  makeReasoning,
  makePlanning,
  makeNoTools,
} from "@moolam/contract-mocks";

const profile = {
  domainId: "education-mathematics",
  charter:
    "You are a patient mathematics mentor. Diagnose gaps before explaining. Prefer questions over answers when the subject is close.",
  refusals: ["Never complete graded assessments on the subject's behalf."],
  languages: ["en-IN", "hi-IN"],
};

const packRoot = resolveTeacherCbseSlicePackRoot();
const knowledge = loadTeacherCbseSliceConnector({
  packRoot,
  subjectId: "subject-1",
  deviceId: "dev-teacher-basic",
  nowMs: Date.parse("2026-07-15T00:00:00.000Z"),
});

const desc = knowledge.describe();
if (desc.locality !== "bundled-offline") {
  throw new Error(`expected bundled-offline pack, got ${desc.locality}`);
}
if (!packRoot.replace(/\\/g, "/").includes("/knowledge-packs/")) {
  throw new Error("teacher pack must load from knowledge-packs/ data path");
}
if (packRoot.replace(/\\/g, "/").includes("/domains/")) {
  throw new Error("must not load knowledge from domains/ import path");
}

const core = new CognitiveCore(profile, {
  memory: makeMemory(),
  model: makeModel("mentor"),
  reasoning: makeReasoning(),
  planning: makePlanning(),
  tools: makeNoTools(),
  knowledge,
});

const out = await core.turn({
  subjectId: "subject-1",
  sessionId: "session-1",
  utterance: "I do not understand why 3:4 and 6:8 are the same ratio.",
});

console.log("pack       :", desc.packId, `@ ${desc.asOf}`);
console.log("locality   :", desc.locality);
console.log("reply      :", out.reply);
console.log("citations  :", out.citations.join(", "));
console.log("trace ref  :", out.traceRef);
if (!out.citations.length) throw new Error("expected grounded citations");
console.log("teacher-basic OK");

