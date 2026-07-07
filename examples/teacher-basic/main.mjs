// teacher-basic: the cognitive core configured as an education mentor.
// The infrastructure is domain-agnostic; everything education-specific in
// this file is configuration (profile + knowledge corpus), per domains/teacher.
import { CognitiveCore } from "@moolam/sdk";
import { makeMemory, makeModel, makeReasoning, makeKnowledge, makePlanning, makeNoTools } from "../_shared/mocks.mjs";

const profile = {
  domainId: "education-mathematics",
  charter:
    "You are a patient mathematics mentor. Diagnose gaps before explaining. Prefer questions over answers when the subject is close.",
  refusals: ["Never complete graded assessments on the subject's behalf."],
  languages: ["en-IN", "hi-IN"],
};

const knowledge = makeKnowledge("maths-corpus", [
  { content: "A ratio compares two quantities by division; 3:4 means 3 parts to 4 parts.", asOf: "2024-06-01" },
  { content: "Equivalent fractions represent the same value: 1/2 = 2/4 = 3/6.", asOf: "2024-06-01" },
  { content: "A percentage is a ratio with denominator 100.", asOf: "2024-06-01" },
]);

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

console.log("reply     :", out.reply);
console.log("citations :", out.citations.join(", "));
console.log("trace ref :", out.traceRef);
if (!out.citations.length) throw new Error("expected grounded citations");
console.log("teacher-basic OK");
