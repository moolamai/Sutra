# @moolam/conformance-cli

Thin independence-kit helper for second implementors. Verifies the fixtures
tarball + [`CERTIFICATION-CHECKLIST.md`](../../docs/protocol/CERTIFICATION-CHECKLIST.md)
extracted from `@moolam/contract-conformance` without a Sutra monorepo checkout.

Obligation execution stays on the published `conformance` bin from
`@moolam/contract-conformance`.

```bash
tar -xzf path/to/independence-kit.tgz -C ./kit
node tools/conformance-cli/bin/conformance-cli.mjs verify \
  --kit ./kit \
  --subject-id cert.kit \
  --device-id external-ci
```

`verify` emits `independence_kit.verify` events with `subjectId` / `deviceId` /
outcome codes — never raw learner content.
