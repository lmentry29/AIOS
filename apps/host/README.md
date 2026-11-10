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

Policy administration is offline and human-only:

```sh
node apps/host/dist/cli.js publish-policy --config /abs/host.json --policy /abs/policy.json
```

The contract, configuration schema, route table, security properties, and open blockers are
documented in
[`docs/engineering/trusted-host-composition-root.md`](../../docs/engineering/trusted-host-composition-root.md).

Task, Workflow, Artifact, and dispatch-run state is durable through a hash-chained journal
(ADR-0015). Dispatch requires an `Idempotency-Key`, holds a renewable lease, and is recovered
as interrupted rather than completed after a crash. Learning records are still in-memory,
live evidence integrations are unverified, and no real executor or verifier ships with the
repository, so this host is not yet production-ready.
