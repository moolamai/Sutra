// vision: a multimodal turn. A visual attachment is analyzed by the bound
// VisionInterface and folded into the working context before reasoning.
import { CognitiveCore } from "@moolam/sdk";
import { makeMemory, makeModel, makeReasoning, makeKnowledge, makePlanning, makeNoTools } from "../_shared/mocks.mjs";

/** Mock VisionInterface: "reads" the attachment bytes as OCR text. */
const vision = {
  maxInputBytes: 1024 * 1024,
  analyze: async (request) => {
    if (request.input.data.length > 1024 * 1024) throw new Error("input exceeds declared size limit");
    const ocr = new TextDecoder().decode(request.input.data);
    return {
      answer: `Handwritten content detected: "${ocr}"`,
      regions: [{ bbox: [0.1, 0.2, 0.8, 0.3], label: "equation", content: ocr }],
      confidence: 0.91,
    };
  },
};

const core = new CognitiveCore(
  {
    domainId: "education-mathematics",
    charter: "You are a mathematics mentor. When shown work, find the first incorrect step.",
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
      { content: "When cross-multiplying a/b = c/d, the products are ad and bc.", asOf: "2024-06-01" },
    ]),
    vision,
  },
);

const out = await core.turn({
  subjectId: "subject-5",
  sessionId: "session-1",
  utterance: "Is my cross-multiplication right?",
  attachment: { data: new TextEncoder().encode("3/4 = 6/8 so 3*8 = 4*6 = 24"), mimeType: "image/png" },
});

console.log("reply:", out.reply);
if (!out.reply.includes("re:")) throw new Error("reply missing");
console.log("vision OK");
