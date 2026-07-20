<div align="center">

# Sutra

**The open-source, offline-first cognitive infrastructure for AI companions**

[Docs](docs/README.md) · [Quickstart](docs/sdk/implementor-quickstart.md) · [Examples](examples/) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/ROADMAP.md)

[![License](https://img.shields.io/github/license/moolamai/sutra)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/moolamai/sutra?style=flat)](https://github.com/moolamai/sutra/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/moolamai/sutra?style=flat)](https://github.com/moolamai/sutra/network/members)
[![Latest tag](https://img.shields.io/github/v/tag/moolamai/sutra?label=tag)](https://github.com/moolamai/sutra/tags)
[![npm version](https://img.shields.io/npm/v/sutra-sdk)](https://www.npmjs.com/package/sutra-sdk)
[![npm downloads](https://img.shields.io/npm/dm/sutra-sdk)](https://www.npmjs.com/package/sutra-sdk)
[![PyPI version](https://img.shields.io/pypi/v/sutra-sdk)](https://pypi.org/project/sutra-sdk/)
[![Contributors](https://img.shields.io/github/contributors/moolamai/sutra)](https://github.com/moolamai/sutra/graphs/contributors)

</div>

Sutra is open infrastructure for building AI companions that can run on the devices people already own—without sending every conversation to the cloud. It gives you a stable TypeScript SDK, a frozen sync protocol, and a reference Python cloud host so tutors, assistants, and domain-specific companions can work offline first and stay in sync when connectivity returns. Built in the open for sovereign, privacy-respecting deployments, with a strong focus on India and emerging markets.

## Get started

**TypeScript / Node (application SDK)**

```bash
npm install sutra-sdk
```

**Python (reference cloud host)**

```bash
pip install sutra-sdk
```

**Scaffold a new companion app**

```bash
npx @moolam/create-sutra --name my-companion --domain teacher \
  --storage memory --transport http --out ./my-companion --yes
```

Monorepo contributors can run the same CLI via `pnpm create-sutra` from a Sutra checkout (write the output outside the repo). See the [implementor quickstart](docs/sdk/implementor-quickstart.md).

**Minimal turn** (pattern from the `create-sutra` scaffold; swap in your own bindings for production):

```ts
import { CognitiveCore } from "sutra-sdk";

const core = new CognitiveCore(profile, {
  memory,
  model,
  reasoning,
  planning,
  tools,
  knowledge,
});

const out = await core.turn({
  subjectId: "subject-1",
  sessionId: "session-1",
  utterance: "I do not understand why 3:4 and 6:8 are the same ratio.",
});

console.log(out.reply);
```

→ Full path: [install → first turn → sync](docs/sdk/implementor-quickstart.md)

## What's inside

| Piece | Where | Role |
| --- | --- | --- |
| `sutra-sdk` | [npm](https://www.npmjs.com/package/sutra-sdk) | Public TypeScript SDK — one import for the cognitive loop, runtime, sync, and edge host APIs |
| `sutra-bindings-*` | npm (`sutra-bindings-slm`, `-speech`, `-vision`, `-knowledge`) | Optional certified on-device model, speech, vision, and knowledge-pack adapters |
| `sutra-sdk` | [PyPI](https://pypi.org/project/sutra-sdk/) | Reference Python cloud orchestrator (FastAPI + sync service) |
| Protocol **1.0** (frozen) | [RFC 0001](rfcs/0001-protocol-1.0-freeze.md) | Versioned wire contract and CRDT merge semantics — additive-only within major version 1 |

## Why Sutra

- **Offline-first** — full companion turns on-device; the network is optional, not required.
- **Frozen protocol** — [Protocol 1.0](rfcs/0001-protocol-1.0-freeze.md) is accepted and version-locked; edge and cloud reconcile without losing offline work.
- **Certified bindings** — optional on-device SLM, speech, vision, and knowledge packs with a conformance path for implementors.
- **Privacy by design** — subject-scoped state, friction telemetry without raw keystrokes; learning stays under your policy (see [field pilot kit](docs/pilot/FIELD-PILOT-KIT.md)).
- **Swappable core** — memory, models, reasoning, and tools are interfaces; swap vendors without rewriting the loop.
- **Apache-2.0** — use, modify, and ship companions without a proprietary platform tax.

## Documentation

| Topic | Link |
| --- | --- |
| Implementor quickstart | [docs/sdk/implementor-quickstart.md](docs/sdk/implementor-quickstart.md) |
| Docs site (VitePress + API) | [docs-site/README.md](docs-site/README.md) |
| Architecture & diagrams | [docs/architecture/README.md](docs/architecture/README.md) |
| Protocol spec | [docs/protocol/README.md](docs/protocol/README.md) |
| Publish & release ops | [docs/sdk/PUBLISH-CHECKLIST.md](docs/sdk/PUBLISH-CHECKLIST.md) |
| Security review summary | [docs/security/SECURITY-REVIEW-SUMMARY.md](docs/security/SECURITY-REVIEW-SUMMARY.md) |
| Dependency audit triage | [security/AUDIT-TRIAGE-POLICY.md](security/AUDIT-TRIAGE-POLICY.md) |

Layered reference material lives under [`docs/`](docs/README.md) (overview, roadmap, ADRs, domains). Protocol freeze evidence: [`rfcs/0001-protocol-1.0-freeze.md`](rfcs/0001-protocol-1.0-freeze.md).

## Contributing

We welcome code, docs, domain configurations, evaluations, and design review. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, standards, and the RFC process for wire-contract changes.

Pull requests run **eight CI jobs**: DCO sign-off, TypeScript build & test, Python build & test, protocol conformance, architecture docs, security & supply chain, release readiness, and integrations/scaffolds (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## License

Apache-2.0 © [Moolam AI](https://github.com/moolamai). See [LICENSE](LICENSE).
