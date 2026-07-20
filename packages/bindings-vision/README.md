# `sutra-bindings-vision`

Local vision-language model binding behind `VisionInterface`.

| Gate | Behavior |
|------|----------|
| `maxInputBytes` | Typed `VisionInputTooLargeError` **before** any model invocation |
| `responseSchema` | `answer` MUST be schema-valid JSON; prose / invalid JSON → typed `VisionSchemaError` |
| Corrupt / unsupported image | Typed `VisionFormatError` — never a native decoder crash |

CK-06 fixtures (`fixtures/ck06/`): `image-over-limit` → **CK-06.1**; `valid-schema-answer` + `model-returned-invalid-json` → **CK-06.2**.

Document extraction schemas (`schemas/`): `cbse-worksheet.v1.json`, `textbook-page.v1.json`, `prescription-sketch.v1.json` — versioned `responseSchema` profiles with synthetic fixtures under `fixtures/document/`. Nullable unknowns + `partial` / `unresolvedFields`; single-page only (multi-image batches rejected). Prescription path: `extractPrescriptionSketch` / `provePrescriptionSketchExtraction`.

Teacher/doctor **golden** fixtures (`fixtures/document/golden/`): redacted probe images + expected JSON, rubric scoring (`runDocumentGoldenSuite`), CI job `vision-document-golden` (`ci:certify:document-golden` / `ci:prove:document-golden`). No PII in committed fixtures.

Edge / offline prove: `proveOfflineEdgeVisionBinding` injects `VisionInterface` into the edge CognitiveBindings set and runs a committed-fixture turn with network denied (`examples/offline-edge` → `pnpm offline-edge:vision`). Playground-facing demo: `examples/vision`.

```bash
pnpm --filter sutra-bindings-vision test
```

Locality: **on-device**. Telemetry event `bindings_vision.vlm` / `bindings_vision.document_understanding` carries `subjectId` / `deviceId` / `outcome` — never raw image bytes or instruction bodies.
