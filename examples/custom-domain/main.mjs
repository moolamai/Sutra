// custom-domain: how to author a NEW domain adapter without forking infrastructure.
//
// A domain is configuration, not platform code:
//   1. AgentProfile     (charter, refusals, languages)
//   2. Task graph       (prerequisite rows the router walks - data, not code)
//   3. Knowledge corpus (citation-bearing passages behind KnowledgeConnectorInterface)
//   4. Tool pack        (optional; risk-classed descriptors + handlers)
//   5. Contract bindings (memory, model, reasoning, planning, tools, knowledge)
//
// Compare with teacher-basic/ and lawyer-basic/: same CognitiveCore, different
// configuration. This example uses agronomy (not yet a domains/ spec) to show
// the pattern from scratch.
import { CognitiveCore } from "sutra-sdk";
import { makeMemory, makeModel, makeReasoning, makeKnowledge, makePlanning } from "@moolam/contract-mocks";


// --- 1. AgentProfile: who the agent is and what it must refuse ---
const profile = {
  domainId: "agronomy-field-advisor",
  charter:
    "You are a field agronomy companion. Ground every recommendation in bundled advisories with citations. Prefer observation questions before prescribing action.",
  refusals: [
    "Never recommend a pesticide without citing the advisory and checking the crop stage.",
    "Never substitute for a licensed agronomist on regulated applications.",
  ],
  languages: ["hi-IN", "en-IN"],
};

// --- 2. Task graph: flat rows, loaded as data (production: JSON/YAML file) ---
// The cloud task router walks this DAG; you author rows, not graph code.
const TASK_GRAPH = [
  { conceptId: "crop.identification", title: "Identify crop and growth stage", prerequisites: [] },
  { conceptId: "symptom.observation", title: "Observe symptoms (leaf, stem, fruit)", prerequisites: ["crop.identification"] },
  { conceptId: "advisory.lookup", title: "Match symptoms to advisory", prerequisites: ["symptom.observation"] },
  { conceptId: "action.recommendation", title: "Recommend field action", prerequisites: ["advisory.lookup"] },
];

// --- 3. Knowledge corpus: bundled-offline passages with citations ---
const knowledge = makeKnowledge("agri-advisories", [
  {
    content: "Yellowing of lower leaves in rice at tillering may indicate nitrogen deficiency; confirm with soil test before top-dressing.",
    asOf: "2025-03-01",
  },
  {
    content: "Brown leaf spot on rice appears as oval lesions with gray centers; avoid excess nitrogen and improve drainage.",
    asOf: "2025-03-01",
  },
  {
    content: "Integrated pest management for rice: scout weekly, treat only above economic threshold, rotate actives.",
    asOf: "2024-11-15",
  },
]);

// --- 4. Tool pack: read/compute only for this demo (see tool-use/ for risk classes) ---
const tools = {
  list: () => [
    {
      name: "advisory-lookup",
      description: "Fetch advisory metadata for a crop and symptom code",
      parameters: { type: "object", properties: { crop: { type: "string" }, symptom: { type: "string" } }, required: ["crop"] },
      riskClass: "read",
    },
  ],
  invoke: async (invocation) => ({
    invocationId: invocation.invocationId,
    status: "ok",
    output: `advisory hit for crop=${invocation.arguments.crop ?? "unknown"}`,
    latencyMs: 1,
  }),
};

// --- 5. Bindings: swap mocks for production adapters (vector DB, SLM, STT, etc.) ---
const core = new CognitiveCore(profile, {
  memory: makeMemory(),
  model: makeModel("agronomy-companion"),
  reasoning: makeReasoning(),
  planning: makePlanning(),
  tools,
  knowledge,
});

// --- 6. Run one turn ---
const out = await core.turn({
  subjectId: "field-plot-7",
  sessionId: "session-1",
  utterance: "My rice plants have yellow lower leaves during tillering. What should I check first?",
});

console.log("domainId  :", profile.domainId);
console.log("task graph:", TASK_GRAPH.map((n) => n.conceptId).join(" -> "));
console.log("reply     :", out.reply);
console.log("citations :", out.citations.join(", "));
if (!out.citations.length) throw new Error("domain answers must carry citations");
console.log("custom-domain OK");
