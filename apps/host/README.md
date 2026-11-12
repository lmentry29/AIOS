# @aios/host

The trusted local composition root. It authenticates a caller, binds the request to a
trusted principal, composes one durable authorization boundary, and injects that same
boundary into `@aios/founder` and `@aios/orchestration`.

It is an application, not a tenth `@aios/*` package: it changes no package boundary.

```sh
pnpm --filter @aios/host run build
node apps/host/dist/cli.js serve --config /abs/path/host.json
```

`dispatch: false` in the startup log and `GET /health` means no execution adapter or
independent verifier was configured. Dispatch then returns 503 instead of simulating work.

The offline bootstrap path remains human-only:

```sh
node apps/host/dist/cli.js publish-policy --config /abs/host.json --policy /abs/policy.json
node apps/host/dist/cli.js revoke-policy --config /abs/host.json --revocation /abs/revocation.json
```

The journal has an offline recovery path. Both commands require the host to be stopped:

```sh
node apps/host/dist/cli.js compact-journal --config /abs/host.json --archive /abs/archive.json
node apps/host/dist/cli.js restore-journal --config /abs/host.json --archive /abs/archive.json
```

Compaction exports a digest-verified archive and replaces the live journal with one snapshot
record that names the archived head. Restore validates the whole archive before writing,
refuses a different valid journal, preserves a damaged target as a backup, and is idempotent
for the same archive. Archives are integrity-checked but not encrypted or signed, and their
retention is an operator responsibility (ADR-0025).

While the host is running, a human principal with an exact `administer_policy` grant on
every target may publish and attach a replacement through `POST /v1/policies`; the policy
and all attachments commit atomically and the next authorization decision uses the new
policy. A missing grant, invalid artifact, stale version, or failed audit append leaves the
prior policy effective. A human principal with an exact `revoke_policy` grant on every
resource that references a version may retire it through
`POST /v1/policies/:policyId/revoke`. Retirement requires the complete target set, reattaches
the newest remaining version, or leaves the resource with no policy so later decisions fail
closed. A retired version cannot be reattached. There is no detached policy signature yet.

The contract, configuration schema, route table, security properties, and open blockers are
documented in
[`docs/engineering/trusted-host-composition-root.md`](../../docs/engineering/trusted-host-composition-root.md).

Task, Workflow, Artifact, and dispatch-run state is durable through a hash-chained journal
(ADR-0015). Dispatch requires an `Idempotency-Key`, holds a renewable lease, and is recovered
as interrupted rather than completed after a crash. Learning records, including
approval-gated permanent Memory stages, are durable in a separate journal. The fixed local
executor and independent verifier are implemented, but no Docker/bubblewrap/Seatbelt provider
could be exercised in this environment; dispatch fails closed when no provider passes its
probe. Live evidence integrations remain unverified, and this host is not yet
production-ready.
