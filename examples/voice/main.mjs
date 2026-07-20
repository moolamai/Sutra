// voice: CognitiveCore with injectable local STT (whisper.cpp-class).
// Streams partial transcripts from an Indic fixture, then runs a core turn
// and synthesizes the reply. Network is unused (on-device binding).
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
  indicFixtureAsAudioStream,
  loadIndicUtteranceFixture,
  loadWhisperCppSpeech,
} from "sutra-bindings-speech";

const speech = await loadWhisperCppSpeech({
  subjectId: "caller-12",
  deviceId: "voice-demo",
});

const fixture = loadIndicUtteranceFixture("hi-en-codeswitch");
let partials = 0;
let finalText = "";
for await (const segment of speech.transcribe(
  indicFixtureAsAudioStream(fixture),
)) {
  if (segment.isFinal) finalText = segment.text;
  else partials++;
}
console.log(
  `transcription : ${finalText.length} chars (${partials} streamed partials)`,
);
if (partials < 1 || !finalText) {
  throw new Error("voice STT must emit partial then final");
}

const core = new CognitiveCore(
  {
    domainId: "community-health",
    charter:
      "You are a spoken-first wellness companion. Keep answers short enough to listen to.",
    refusals: ["Never diagnose; always refer symptoms to a clinician."],
    languages: speech.supportedLanguages,
  },
  {
    memory: makeMemory(),
    model: makeModel("voice-companion"),
    reasoning: makeReasoning(),
    planning: makePlanning(),
    tools: makeNoTools(),
    knowledge: makeKnowledge("nutrition-guides", [
      {
        content:
          "A balanced diet includes cereals, pulses, vegetables, fruits, and dairy in proportion.",
        asOf: "2023-01-01",
      },
    ]),
    speech,
  },
);

const out = await core.turn({
  subjectId: "caller-12",
  sessionId: "call-1",
  utterance: finalText,
});
let audioBytes = 0;
for await (const chunk of speech.synthesize(out.reply, {
  language: "en-IN",
})) {
  audioBytes += chunk.data.length;
}
console.log("reply         :", out.reply.slice(0, 80), "…");
console.log("synthesized   :", audioBytes, "bytes of audio");
console.log("languages     :", speech.supportedLanguages.join(", "));
if (!audioBytes) throw new Error("voice loop incomplete");

await speech.unload();
console.log("voice OK");
