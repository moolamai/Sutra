// vision: CognitiveCore with injectable local VLM. Analyzes a committed
// CK-06 fixture image (network unused — on-device binding), folds the
// answer into the working context, then runs a core turn.
import { CognitiveCore } from "sutra-sdk";
import {
  makeMemory,
  makeModel,
  makeReasoning,
  makeKnowledge,
  makePlanning,
  makeNoTools,
} from "@moolam/contract-mocks";
import {
  loadCk06Fixture,
  loadLocalVlm,
} from "sutra-bindings-vision";

const vision = await loadLocalVlm({
  subjectId: "subject-5",
  deviceId: "vision-demo",
  maxInputBytes: 64,
});

const fixture = loadCk06Fixture("valid-schema-answer");
const analyzed = await vision.analyze({
  input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
  instruction: fixture.instruction,
  responseSchema: fixture.schema,
});
console.log(
  `vision analyze : ${analyzed.answer.length} chars (fixture=${fixture.id})`,
);
if (!analyzed.answer.trim()) {
  throw new Error("vision analyze must return a non-empty answer");
}

const core = new CognitiveCore(
  {
    domainId: "education-mathematics",
    charter:
      "You are a mathematics mentor. When shown work, find the first incorrect step.",
    refusals: [],
    languages: ["en-IN"],
  },
  {
    memory: makeMemory(),
    model: makeModel("mentor"),
    reasoning: makeReasoning(),
    planning: makePlanning(),
    tools: makeNoTools(),
    knowledge: makeKnowledge("maths-corpus", [
      {
        content:
          "When cross-multiplying a/b = c/d, the products are ad and bc.",
        asOf: "2024-06-01",
      },
    ]),
    vision,
  },
);

const out = await core.turn({
  subjectId: "subject-5",
  sessionId: "session-1",
  utterance: "Is my cross-multiplication right?",
  attachment: {
    data: fixture.imageBytes,
    mimeType: fixture.mimeType,
  },
});

console.log("reply:", out.reply);
if (!out.reply.includes("re:")) throw new Error("reply missing");
console.log("maxInputBytes :", vision.maxInputBytes);
console.log("fixture       :", fixture.id);

await vision.unload();
console.log("vision OK");

