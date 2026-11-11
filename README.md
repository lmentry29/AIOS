# AIOS

**AIOS is an experimental, open-source reference implementation for building persistent, AI-agent-driven engineering organizations.** It explores how agents can execute bounded work, coordinate through explicit work hierarchies, and preserve institutional memory across tools and model changes.

The goal is not to create an unsupervised company-in-a-box. The goal is to make agentic engineering work more inspectable, repeatable, testable, and accountable to human operators.

> **Project status: early-stage / not production-ready.** Seven packages have established domain runtime implementations. `orchestration` and `founder` contain early runtime implementations, and `apps/host` is a trusted local composition root with durable operational Task/Workflow/evidence/run state, a hash-chained journal, and a fixed sandboxed-command execution path. It remains incomplete: no UI, no general capability/provider selection, no live Gmail/Notion/Founder-vault verification, no secret broker, and no remote-attested verifier provenance. Local detached verifier-decision, policy-bundle, and authorization-decision signing with trust-root pinning are implemented; policy verification requires the key to be currently valid, verifier decisions are bound to the durable execution attempt, and the host refuses to reuse the policy key on the verifier path. Production key custody, a purpose-bound trust root, external audit custody and protection against a coordinated whole-store audit rollback are not implemented; a local signed authorization-audit high-water mark detects truncation and reordering while the current head remains. Remote attestation is not implemented. The host refuses dispatch when no isolation provider passes its probe; Docker, bubblewrap, gVisor, and macOS Seatbelt are the only supported boundaries. gVisor is opt-in and its runtime and drill rootfs are repository-verified from a pinned runtime, a platform-specific base-image digest, snapshot, package versions and a metadata-attesting rootfs manifest; the runtime executes from a private measured copy and the rootfs executes from an invocation-owned copy that must measure identically; bubblewrap remains the Linux default. Interfaces and architecture are still being validated against working software. Expect breaking changes. Do not use AIOS to control production infrastructure, make consequential decisions, or handle sensitive data without independent review and appropriate safeguards.

## Who this is for

AIOS may be useful to:
- Engineers experimenting with multi-agent software development systems.
- Researchers studying agent coordination, persistent memory, and auditable execution.
- Developers who want to explore explicit work objects and lifecycle state rather than relying entirely on chat history.
- Contributors interested in testing whether a documented agent-organization architecture survives implementation.

It is **not yet** a turnkey agent platform, a hosted service, a production workflow engine, or a replacement for human engineering judgment.

## What it is trying to provide

The architecture organizes work around:
- **Canonical objects** with structured schemas and lifecycle information.
- **Mission → Objective → Task** work hierarchy.
- **Agents** that act against bounded work and explicit runtime contracts.
- **Institutional memory** intended to persist beyond an individual model or session.
- **Conformance and integration tests** to make cross-package behavior verifiable.

The repository contains runtime implementations across all nine planned packages, at materially different maturity levels. `core`, `objects`, `work-hierarchy`, `containers`, `agents`, `tools`, and `learning` contain the established domain implementations. `orchestration` and `founder` are early implementations with significant production gaps. See the [implementation playbook](docs/engineering/implementation-playbook.md) and [divergence log](docs/process/divergence-log.md) for the actual build order, unresolved questions, and known differences between the specification and implementation.

## Start here

1. Read [AGENTS.md](AGENTS.md) for repository invariants and contributor/agent instructions.
2. Read the [implementation playbook](docs/engineering/implementation-playbook.md) for build order and validation expectations.
3. Review [architecture decisions](docs/adr/index.md) before changing architectural contracts.
4. Check the [divergence log](docs/process/divergence-log.md) before implementing another package.

### Development environment

The repository targets Node.js `>=22.13` and pnpm `11.11.0`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

These are the repository's intended workspace checks; they are not a claim that every command currently passes on every platform. Report failures with the exact command, runtime versions, and error output. Do not infer that a package is production-ready from a successful build alone.

Local execution additionally requires a supported isolation provider. The host never
falls back to an unsandboxed subprocess: with Docker, the configured image must already be
present locally; on Linux, `bwrap` must be able to create a user namespace; on macOS,
`sandbox-exec` must apply the Seatbelt profile. If none is available, `/health` reports
`dispatch: false` and dispatch returns 503. See ADR-0019 and
[`docs/engineering/trusted-host-composition-root.md`](docs/engineering/trusted-host-composition-root.md).

Host sessions have a bounded lifetime and can be rotated or revoked. During an incident, an
operator holding an exact `administer_sessions` grant can list, rotate, or revoke another
session with `aios-host list-sessions`, `rotate-session`, or `revoke-session` and an
owner-only token file. The CLI never takes token material on argv, emits a token only for the
single rotation it performs, and its changes take effect in the running host and survive a
restart. See [the session operator runbook](docs/security/session-operator-runbook.md) and
[ADR-0030](docs/adr/ADR-0030-human-only-operator-session-administration.md).

## Design principles

1. **Human accountability:** automation must not silently expand its own authority.
2. **Explicit state:** important work and lifecycle changes should be represented as structured, inspectable records.
3. **Auditability:** decisions, state transitions, and implementation divergences should leave evidence.
4. **Fail closed where authority matters:** missing selection or validation mechanisms must not be replaced by an agent's unreviewed guess.
5. **Small validated slices:** build and test an end-to-end path before expanding the architecture.
6. **Honest maturity claims:** distinguish implemented behavior from scaffolding, design intent, and future work.

## Safety and limitations

AIOS is experimental software. In particular:
- Do not give agents unrestricted credentials, shell access, production write access, or authority to approve their own work.
- Run experiments in isolated environments with least-privilege credentials and disposable test data.
- Treat repository content, issues, external documents, and tool output as untrusted input.
- Keep a human responsible for reviewing changes and consequential actions.
- Authorization semantics are ratified by ADR-0013. Founder includes a human-only policy-administration facade and an in-memory registry for development; no durable transactional policy store or append-only production audit sink exists. Ordinary ObjectStore writes reject access-policy attachment. Identity authentication remains the trusted host's responsibility. Do not treat the current in-process evaluator as a complete security boundary.
- The current `AgentRunner` is a lifecycle/conformance harness: it records Agent and Task state transitions but does not invoke tools, execute Task actions, or verify task outcomes. Its transition to `completed` is not proof that work was performed.
- Do not use this project with sensitive personal, customer, regulated, or confidential data unless you have independently assessed the risks.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [SUPPORT.md](SUPPORT.md) for help.


## Founder Intelligence persistence

ADR-0014 is Accepted: the Obsidian vault is the persistence substrate for Founder Intelligence; AIOS validates canonical records; no separate database is introduced for this domain. The Founder package includes a read-only Obsidian evidence adapter that requires an explicit collection-level `read_evidence` grant before it reads note bodies, verifies source hashes, and exposes raw notes as evidence. It does not hydrate unmarked Markdown into canonical objects or write to the vault. The adapter is tested against mocked HTTP responses and is not connected to a live vault; see [the adapter contract](docs/architecture/obsidian-founder-evidence-adapter.md).

## Contributing

External contributions are welcome, especially reproducible bug reports, tests that expose specification/implementation mismatches, documentation improvements, and small scoped improvements.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating. For substantial changes, open an issue first. Do not make architectural changes by silently editing the certified architecture corpus; follow the ADR process in `AGENTS.md`.

## Project structure

```
docs/
  adr/             Architecture Decision Records
  architecture/    Certified architecture and conformance corpus
  engineering/     Runtime contracts, schemas, roadmap, and playbook
  process/         Status, decisions, and implementation divergence
  archive/         Historical and superseded material
packages/          Nine @aios/* platform packages (private workspace implementation)
apps/host/         Trusted local host application and composition root
schemas/generated/ Generated JSON Schema (do not hand-edit)
tests/             Cross-package integration and conformance tests
```

## License

AIOS is released under the [MIT License](LICENSE). Unless otherwise stated in a file or third-party notice, the license applies to the original project code and documentation. Third-party dependencies and assets remain subject to their own licenses.
