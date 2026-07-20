# Changesets

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version bumps and changelog generation on publishable `@moolam/*` packages.

## Adding a changeset

```bash
pnpm changeset
```

Follow the prompts to describe your change and select affected packages. Commit the generated file under `.changeset/`.

## Version bump (release pipeline)

The release workflow calls the gated version-bump script — do not run `changeset version` directly without the config gate:

```bash
pnpm changeset:version
```

This validates `.changeset/config.json` (fixed lockstep group, ignore list, public access) then runs `changeset version` to bump package versions and regenerate per-package changelogs.

## Publish

Publishing is CI-only (`release.yml`). Locally for debugging:

```bash
pnpm changeset:publish
```

## Lockstep versioning

All fourteen public `@moolam/*` packages are in a single `fixed` group so they always share the same semver. Private workspace packages (`cloud-orchestrator`, `contract-conformance`, examples, benchmarks, training, etc.) are listed in `ignore`.
