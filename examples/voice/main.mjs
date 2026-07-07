// voice: a voice-only loop. Streaming transcription (partial segments per
// the speech contract) feeds a core turn; the reply streams back through
// synthesis. The speech stack is a mock; the loop shape is the real one.
import { CognitiveCore } from "@moolam/sdk";
import { makeMemory, makeModel, makeReasoning, makeKnowledge, makePlanning, makeNoTools } from "../_shared/mocks.mjs";

/** Mock SpeechInterface: streams partials, then a final segment. */
const speech = {
  supportedLanguages: ["hi-IN", "en-IN"],
  transcribe: async function* (audio) {
    const words = [];
    for await (const chunk of audio) {
      words.push(chunk.word);
      yield { text: words.join(" "), language: "en-IN", startMs: 0, endMs: words.length * 400, confidence: 0.7, isFinal: false };
    }
    yield { text: words.join(" "), language: "en-IN", startMs: 0, endMs: words.length * 400, confidence: 0.95, isFinal: true };
  },
  synthesize: async function* (text) {
    yield { data: new TextEncoder().encode(text), sampleRateHz: 16000 };
  },
};

// Simulated microphone: word-sized "audio chunks".
async function* microphone() {
  for (const word of ["what", "is", "a", "balanced", "diet"]) yield { word };
}

let partials = 0;
let finalText = "";
for await (const segment of speech.transcribe(microphone())) {
  if (segment.isFinal) finalText = segment.text;
  else partials++;
}
console.log(`transcription : "${finalText}" (${partials} streamed partials)`);

const core = new CognitiveCore(
  {
    domainId: "community-health",
    charter: "You are a spoken-first wellness companion. Keep answers short enough to listen to.",
    refusals: ["Never diagnose; always refer symptoms to a clinician."],
    languages: ["hi-IN", "en-IN"],
  },
  {
    memory: makeMemory(),
    model: makeModel("voice-companion"),
    reasoning: makeReasoning(),
    planning: makePlanning(),
    tools: makeNoTools(),
    knowledge: makeKnowledge("nutrition-guides", [
      { content: "A balanced diet includes cereals, pulses, vegetables, fruits, and dairy in proportion.", asOf: "2023-01-01" },
    ]),
    speech,
  },
);

const out = await core.turn({ subjectId: "caller-12", sessionId: "call-1", utterance: finalText });
let audioBytes = 0;
for await (const chunk of speech.synthesize(out.reply, { language: "en-IN" })) audioBytes += chunk.data.length;
console.log("reply         :", out.reply);
console.log("synthesized   :", audioBytes, "bytes of audio");
if (partials < 2 || !audioBytes) throw new Error("voice loop incomplete");
console.log("voice OK");
