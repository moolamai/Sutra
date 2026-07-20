# Training export and external LoRA runbook

This runbook is for an operator exporting consented turn trajectories to
`training-export.v1` JSONL and handing the resulting dataset manifest to an
external adapter/LoRA tool. Sutra validates and exports the seam; it does not
upload data, resolve content hashes outside the sovereign store, submit a
training job, or operate a managed training service.

## Safety boundary

Run the export and the external trainer inside the subject's declared
`on-device` or `self-hosted` locality boundary. The trajectory store, consent
ledger, output JSONL, content resolver, trainer inputs, checkpoints, and
adapter artifacts must remain there unless a separate, explicit consent and
locality policy authorizes movement.

The export is metadata-only. It contains content hashes and byte lengths, not
prompts, replies, keystrokes, utterances, tool arguments, or tool results. An
external trainer that needs text must resolve each hash against an authorized
local content store inside the same boundary. The export does not grant access
to that store.

Every invocation selects exactly one `subjectId`. Never combine subjects in a
single export or reuse one subject's consent for another.

## Prerequisites

1. Build the telemetry package:

   ```bash
   pnpm --filter @moolam/telemetry build
   ```

2. Prepare a subject-scoped trajectory JSONL snapshot. Each line must satisfy
   `packages/sync-protocol/schemas/TurnTrajectoryV1.json`. For a synthetic
   proof, use:

   ```text
   packages/telemetry/fixtures/trajectory/golden/perceive-reason-act-on-device.json
   ```

   Save its compact JSON form as one line in `trajectories.jsonl`. Production
   snapshots must come from a transactionally consistent, subject-scoped read
   of the sovereign store; do not dump an unbounded shared table.

3. Obtain a fresh consent-ledger snapshot from the sovereign consent vault.
   Keep the snapshot stable for the invocation, and discard the output if the
   vault version changes before handoff. Save the ledger as `consent.json`:

   ```json
   [
     {
       "consentRecordId": "consent-export-001",
       "subjectId": "learner-a",
       "scope": "training-export",
       "optedIn": true,
       "active": true
     }
   ]
   ```

   The CLI ignores inactive, opted-out, wrong-scope, and other-subject records.
   At least one active `training-export` record for the selected subject is
   required.

4. Restrict filesystem permissions on the input directory, output directory,
   and trainer workspace to the operator and the local training process.

## Export

Invoke the export explicitly; do not schedule it as an automatic upload:

```bash
node packages/telemetry/bin/export-trajectories.mjs --store trajectories.jsonl --consent consent.json --subject learner-a --out training.jsonl --limit 1024 --timeout-ms 30000
```

`--limit` defaults to 1024 and may not exceed 4096. Each input file is limited
to 16 MiB. `--timeout-ms` defaults to 30000. The output path must differ from
both input paths.

The CLI:

- reads a bounded snapshot and selects only `learner-a`;
- validates every selected trajectory as untrusted input;
- filters against active, opted-in `training-export` consent;
- orders rows deterministically and removes replayed `turnId` duplicates;
- validates every output row against the training-export contract; and
- writes through a temporary file followed by an atomic rename.

On success, stdout contains only a summary:

```json
{"operation":"export_trajectories","outcome":"completed","subjectId":"learner-a","readCount":1,"exportedCount":1,"filteredCount":0}
```

Structured metadata-only events are written to stderr. Route them to the local
audit sink; do not add prompt, reply, hash, path, or consent-vault content:

```json
{"event":"telemetry.training_export","operation":"export_trajectories","outcome":"completed","subjectId":"learner-a","readCount":1,"exportedCount":1,"filteredCount":0}
```

## Validate before handoff

Check every JSONL row with the same runtime contract used by the exporter:

```bash
node --input-type=module -e "import{readFile}from'node:fs/promises';import{parseTrainingExportLineV1}from'./packages/telemetry/dist/export_pipeline.js';const rows=(await readFile('training.jsonl','utf8')).trim().split(/\r?\n/);for(const [i,row]of rows.entries()){const result=parseTrainingExportLineV1(JSON.parse(row));if(!result.ok)throw new Error('invalid export row '+(i+1)+': '+result.failureClass)}console.log(JSON.stringify({outcome:'valid',rows:rows.length}))"
```

Also verify:

- every row has the requested `subjectId`;
- `exportConsentScope` is `training-export`;
- `exportConsentRecordId` refers to the approved vault snapshot;
- `locality` matches the trainer location;
- no plaintext learner or user content is present; and
- `exportedCount` and the validated row count agree.

Do not hand off an output if any check fails or consent has changed.

## External LoRA handoff

Create a local handoff descriptor such as `finetune-job.json`:

```json
{
  "jobId": "job-lora-001",
  "adapterType": "lora",
  "baseModelId": "slm-edge-v1",
  "datasetUri": "file:///sovereign/training/training.jsonl"
}
```

Validate it without submitting anything:

```bash
node --input-type=module -e "import{readFile}from'node:fs/promises';import{parseFinetuneJob,trainingExportError}from'./packages/telemetry/dist/export_pipeline.js';const value=JSON.parse(await readFile('finetune-job.json','utf8'));const result=parseFinetuneJob(value);if(!result.ok)throw trainingExportError(result);console.log(JSON.stringify({outcome:'valid',jobId:result.value.jobId}))"
```

Then configure the external trainer to:

1. run inside the same locality boundary;
2. accept the validated descriptor and `training.jsonl`;
3. resolve content hashes only through the authorized local resolver;
4. reject missing, mismatched, or unauthorized content references;
5. write checkpoints and the final adapter to the restricted local workspace;
6. record the external tool/version, base-model digest, dataset digest,
   consent snapshot identifier, and outcome in the local audit system; and
7. stop and quarantine partial artifacts on timeout or validation failure.

The external tool's command, content resolver, training configuration,
checkpoint lifecycle, and deployment are operator-owned. They are not Sutra
services and are not implied by `FinetuneJob`.

## Failure playbook

The CLI exits non-zero and emits a structured rejection. Treat each class
distinctly:

- `consent_missing`, `consent_denied`, `consent_scope_invalid`: obtain a fresh
  vault snapshot; never override or synthesize consent.
- `cross_subject`: quarantine the snapshot and investigate the storage query.
  Do not filter the defect away after the fact.
- `no_exportable_trajectories`: no output is written. Confirm the subject and
  consent state; an existing output is not replaced with an empty file.
- `validation` or `raw_content_forbidden`: quarantine the input. The event's
  `obligationId` is `TRAINING_EXPORT.SCHEMA_V1`.
- `limit`: narrow the subject-scoped snapshot or lower the requested batch;
  do not bypass the 4096-record or 16 MiB bounds.
- `timeout`, `read_failed`, or `write_failed`: inspect local storage health and
  permissions, discard temporary/partial trainer artifacts, and retry only as
  a new explicit invocation.

Concurrent captures are outside the transactionally consistent snapshot and
belong to a later export. Re-running the same snapshot is safe: duplicate
`turnId` values are removed deterministically, and the final output is replaced
atomically only after complete validation.

## Closeout

Before leaving the restricted workspace:

- re-check consent and locality;
- retain only artifacts required by the operator's approved retention policy;
- securely remove temporary plaintext material created by the external
  resolver or trainer;
- keep metadata-only export and training audit events; and
- do not upload the dataset or adapter merely because export succeeded.

The executable happy path, mixed-consent filtering, cross-subject rejection,
empty-export preservation, replay deduplication, timeout, and atomic-write
behavior are covered by
`packages/telemetry/tests/trajectory_format.test.mjs`.
