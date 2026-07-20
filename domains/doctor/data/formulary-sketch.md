# Doctor formulary sketch (bundled-offline reference)

Authoring source for the flagship knowledge pack
`knowledge-packs/doctor-formulary-sketch/`.

**Packages never import this file.** The pack build pipeline
(`packages/bindings-knowledge/scripts/build_pack.mjs`) reads it as
filesystem input only and emits validated pack data plus `provenance.json`.

## Safety (domain posture)

Support, never diagnosis or prescription. Pack **title** and **description**
fields must stay non-advisory. Regulatory and clinical-use disclaimers live in
**citation metadata** (locator / source tier), not as “take this drug” copy in
pack titles.

See `domains/doctor/README.md` and `tools.md` (`formulary-search`,
`interaction-checker`).

## Pack authoring payload

<!-- pack-build:v1 -->

```json
{
  "packId": "pack.doctor.formulary-sketch",
  "version": "1.0.0",
  "title": "Doctor formulary sketch (reference data; not clinical advice)",
  "asOf": "2026-06-01T00:00:00.000Z",
  "locality": "bundled-offline",
  "languages": ["en"],
  "sources": [
    {
      "sourceId": "src.formulary.sketch.national",
      "title": "National formulary sketch (bundled offline excerpt)",
      "domain": "doctor",
      "locality": "bundled-offline",
      "coverage": {
        "from": "2024-01-01",
        "to": "2026-06-01"
      }
    },
    {
      "sourceId": "src.formulary.sketch.disclaimer",
      "title": "Regulatory disclaimer block (companion charter)",
      "domain": "doctor",
      "locality": "bundled-offline",
      "coverage": {
        "from": "2024-01-01",
        "to": "2026-06-01"
      }
    }
  ],
  "shard": {
    "shardId": "shard.formulary.sketch",
    "relpath": "content/shard-formulary.json",
    "passages": [
      {
        "passageId": "pass.disclaimer.companion",
        "content": "This companion presents ranked considerations with citations and confidence. The clinician decides. The companion never diagnoses and never issues a prescription.",
        "citation": {
          "citationId": "cite.disclaimer.companion",
          "sourceId": "src.formulary.sketch.disclaimer",
          "locator": "Source tier: regulatory-disclaimer · Not clinical advice · Clinician decides; not a prescription"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.disclaimer.currency",
        "content": "Guideline and formulary currency is safety-critical: treat each passage asOf as a staleness gate before relying on the excerpt in an encounter.",
        "citation": {
          "citationId": "cite.disclaimer.currency",
          "sourceId": "src.formulary.sketch.disclaimer",
          "locator": "Source tier: regulatory-disclaimer · asOf currency gate · Not clinical advice"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.paracetamol.label",
        "content": "Paracetamol (acetaminophen) label excerpt: adult oral reference ceiling commonly cited as 4 g in 24 hours in many national labels; verify the active label for the locality before any clinical use.",
        "citation": {
          "citationId": "cite.formulary.paracetamol.label",
          "sourceId": "src.formulary.sketch.national",
          "locator": "Source tier: national-formulary · Paracetamol label excerpt · Disclaimer: decision-support reference only; not a prescription"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.interaction.warfarin.nsaid",
        "content": "Interaction monograph excerpt: concurrent warfarin and NSAID exposure is associated with elevated bleeding risk in standard interaction references; unresolved interaction checks must be surfaced, never dropped.",
        "citation": {
          "citationId": "cite.interaction.warfarin.nsaid",
          "sourceId": "src.formulary.sketch.national",
          "locator": "Source tier: interaction-monograph · Warfarin–NSAID · Disclaimer: decision-support reference only; clinician decides"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.allergy.prerequisite",
        "content": "Before discussing management options, recorded allergies and current medications are prerequisites; missing allergy history loops the encounter back rather than advancing.",
        "citation": {
          "citationId": "cite.workflow.allergy.prereq",
          "sourceId": "src.formulary.sketch.disclaimer",
          "locator": "Source tier: workflow-prerequisite · Allergies/medications · Disclaimer: operational gate, not clinical advice"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      }
    ]
  }
}
```

<!-- /pack-build:v1 -->
