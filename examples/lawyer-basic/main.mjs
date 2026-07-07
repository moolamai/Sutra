// lawyer-basic: the SAME cognitive core as teacher-basic, configured as a
// legal research companion. Diff this file against teacher-basic/main.mjs:
// only the profile and the knowledge corpus change.
import { CognitiveCore } from "@moolam/sdk";
import { makeMemory, makeModel, makeReasoning, makeKnowledge, makePlanning, makeNoTools } from "../_shared/mocks.mjs";

const profile = {
  domainId: "legal-research-in",
  charter:
    "You are a legal research companion for advocates. Cite every authority. Distinguish holding from dicta. You support research; you do not give legal advice to end clients.",
  refusals: [
    "Never present a conclusion without a citation.",
    "Never advise on matters outside Indian jurisdiction without flagging it.",
  ],
  languages: ["en-IN"],
};

const knowledge = makeKnowledge("case-law", [
  { content: "Section 10, Indian Contract Act 1872: all agreements are contracts if made by free consent of parties competent to contract, for a lawful consideration and object.", asOf: "1872-04-25" },
  { content: "Consideration may be past, present, or future, but must be real and lawful.", asOf: "1872-04-25" },
]);

const core = new CognitiveCore(profile, {
  memory: makeMemory(),
  model: makeModel("legal-companion"),
  reasoning: makeReasoning(),
  planning: makePlanning(),
  tools: makeNoTools(),
  knowledge,
});

const out = await core.turn({
  subjectId: "matter-204",
  sessionId: "session-1",
  utterance: "What are the essentials of a valid contract under the Indian Contract Act?",
});

console.log("reply     :", out.reply);
console.log("citations :", out.citations.join(", "));
if (!out.citations.length) throw new Error("legal answers must carry citations");
console.log("lawyer-basic OK");
