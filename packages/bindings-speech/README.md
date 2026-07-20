# `sutra-bindings-speech`

Local Indic speech bindings: whisper.cpp-class STT and local TTS behind `SpeechInterface`.

## Indic TTS voice coverage

Authoritative model card: [`fixtures/tts/tts-voices.model-card.json`](./fixtures/tts/tts-voices.model-card.json)  
Loaded voices (runtime): [`fixtures/tts/voices.json`](./fixtures/tts/voices.json)

`loadLocalTts()` / `loadTtsVoiceModelCard()` declare `supportedLanguages` **only** from this coverage — never aspirational. Hindi + English + ≥1 additional Indic (Tamil).

| Language (BCP-47) | Voice id | Role | Script |
|-------------------|----------|------|--------|
| `hi-IN` | `indic-hi-f1` | primary-indic | Devanagari |
| `en-IN` | `indic-en-f1` | fallback-english | Latin |
| `ta-IN` | `indic-ta-f1` | additional-indic | Tamil |

Programmatic table: `languageVoiceCoverageTable()` (must stay in lockstep with the model card and README).

## TTS language fallback (CK-05.2)

Declared `fallbackLanguage`: **`en-IN`**.

| Request | Behavior |
|---------|----------|
| Language in `supportedLanguages` | Synthesize with that voice; telemetry `outcome: "ok"` |
| Unsupported BCP-47 | Route to declared `fallbackLanguage` (`en-IN`); telemetry `outcome: "fallback"` + `usedFallback: true` — **never throw**, never silent English substitution without that signal |
| Empty / whitespace text | Typed `LocalTtsError` (`validation`) before synthesis starts |
| Mixed-script (Devanagari + Latin) | Synthesizes without crash; language selection still follows requested BCP-47 + fallback (no mid-utterance auto-switch) |

Locality: **on-device**. Telemetry event `bindings_speech.tts` carries `subjectId` / `deviceId` / `outcome` — never raw synthesis text.

## Quick commands

```bash
pnpm --filter sutra-bindings-speech test
pnpm --filter sutra-bindings-speech run certify:speech
pnpm --filter sutra-bindings-speech run prove:speech-cert
```

Speech CI certification (CK-05 STT+TTS + Indic fixtures): see [`certification/README.md`](./certification/README.md).
