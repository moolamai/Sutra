# CBSE Class 8 Mathematics — Ratios & Proportions (syllabus slice)

Authoring source for the flagship knowledge pack
`knowledge-packs/teacher-cbse-slice/`.

**Packages never import this file.** The pack build pipeline
(`packages/bindings-knowledge/scripts/build_pack.mjs`) reads it as
filesystem input only and emits validated pack data plus `provenance.json`.

## Syllabus alignment

| Track | Concepts (this slice) | Age floor |
|-------|------------------------|-----------|
| `cbse-class-8-maths` | ratios, equivalent ratios, fractions as prerequisites, percentages, simple proportion | 12 |

Prerequisite remediation (see `domains/teacher/workflows.md`): friction on
ratios with weak fractions loops back to fractions before advancing.

## Task-graph concept inventory

Stable `conceptId` keys for the CBSE-slice **task-graph** pack
(`task-graph-packs/teacher-cbse-slice.json` /
`packages/domain-loader/fixtures/packs/teacher-cbse-slice.json`).
Machine-readable twin: [`task-graph-concept-ids.json`](./task-graph-concept-ids.json).
This is distinct from the knowledge pack at `knowledge-packs/teacher-cbse-slice/`.

| conceptId | Title | Role |
|-----------|-------|------|
| `math.fractions` | Fractions | Prerequisite (remediate when ratios friction + weak mastery) |
| `math.ratios` | Ratios | Core |
| `math.equivalent_ratios` | Equivalent ratios | Core |
| `math.percentages` | Percentages | Core |
| `math.simple_proportion` | Simple proportion | Core |
| `math.unitary_method` | Unitary method | Core |

Pedagogical edges (dependent → requires): ratios→fractions; equivalent_ratios→ratios;
percentages→ratios; simple_proportion→ratios + equivalent_ratios;
unitary_method→simple_proportion. No synthetic probe nodes.

## Pack authoring payload

The fenced JSON below is the machine-readable pack authoring contract.
Human narrative above is documentation only.

<!-- pack-build:v1 -->

```json
{
  "packId": "pack.teacher.cbse-slice",
  "version": "1.0.0",
  "title": "Teacher CBSE maths slice (bundled-offline)",
  "asOf": "2026-06-01T00:00:00.000Z",
  "locality": "bundled-offline",
  "languages": ["en", "hi"],
  "sources": [
    {
      "sourceId": "src.ncert.class8.math.ratios",
      "title": "NCERT Class 8 Mathematics — Ratios & Proportions (slice)",
      "domain": "teacher",
      "locality": "bundled-offline",
      "coverage": {
        "from": "2024-01-01",
        "to": "2026-06-01"
      }
    }
  ],
  "shard": {
    "shardId": "shard.cbse.ratios",
    "relpath": "content/shard-ratios.json",
    "passages": [
      {
        "passageId": "pass.ratio.compare",
        "content": "A ratio compares two quantities by division; 3:4 means 3 parts to 4 parts.",
        "citation": {
          "citationId": "cite.ncert.8.math.ratio.p1",
          "sourceId": "src.ncert.class8.math.ratios",
          "locator": "NCERT Class 8 Math — Ratios, §Comparing quantities"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.ratio.equivalent",
        "content": "Equivalent ratios represent the same comparison: 3:4 and 6:8 are the same ratio because both sides scale by 2.",
        "citation": {
          "citationId": "cite.ncert.8.math.ratio.p2",
          "sourceId": "src.ncert.class8.math.ratios",
          "locator": "NCERT Class 8 Math — Ratios, §Equivalent ratios"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.fraction.equivalent",
        "content": "Equivalent fractions represent the same value: 1/2 = 2/4 = 3/6.",
        "citation": {
          "citationId": "cite.ncert.8.math.frac.p1",
          "sourceId": "src.ncert.class8.math.ratios",
          "locator": "NCERT Class 8 Math — Fractions, §Equivalent fractions"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.percent.ratio",
        "content": "A percentage is a ratio with denominator 100.",
        "citation": {
          "citationId": "cite.ncert.8.math.pct.p1",
          "sourceId": "src.ncert.class8.math.ratios",
          "locator": "NCERT Class 8 Math — Percentages"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.proportion.simple",
        "content": "A proportion states that two ratios are equal: a:b = c:d means a/b = c/d.",
        "citation": {
          "citationId": "cite.ncert.8.math.prop.p1",
          "sourceId": "src.ncert.class8.math.ratios",
          "locator": "NCERT Class 8 Math — Proportions, §Equality of ratios"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      },
      {
        "passageId": "pass.unitary.method",
        "content": "The unitary method finds the value of one unit first, then scales to the required number of units.",
        "citation": {
          "citationId": "cite.ncert.8.math.unit.p1",
          "sourceId": "src.ncert.class8.math.ratios",
          "locator": "NCERT Class 8 Math — Comparing quantities, §Unitary method"
        },
        "asOf": "2024-06-01T00:00:00.000Z"
      }
    ]
  }
}
```

<!-- /pack-build:v1 -->
