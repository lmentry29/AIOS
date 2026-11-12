# Signed application archive

`tools/security/app-archive.mjs` implements the ADR-0038 distribution unit. It is deliberately
separate from npm publishing: `@aios/*` remains private, and the archive is the reviewable
application artifact.

## Create

The unsigned review archive needs only a built workspace:

```sh
pnpm turbo build
node tools/security/app-archive.mjs create \
  --root . \
  --out /tmp/aios-host.tar \
  --commit "$(git rev-parse HEAD)" \
  --release aios-host \
  --profile local-secure
```

A signed release additionally needs an `artifact`-purpose key from the operator's v2 trust
root. The private key is read from the operator-supplied path and is never printed or put in
the archive:

```sh
node tools/security/app-archive.mjs create \
  --root . \
  --out aios-host.tar \
  --signature aios-host.tar.sig.json \
  --trust-root /operator/trust-root.json \
  --key-file /operator/artifact-key.pem \
  --key-id <64-hex-key-id> \
  --commit "$(git rev-parse HEAD)" \
  --release aios-host \
  --profile local-secure
```

## Verify

Verification is offline and needs only the archive, detached signature, trust root and the
release identity:

```sh
node tools/security/app-archive.mjs verify \
  --archive aios-host.tar \
  --signature aios-host.tar.sig.json \
  --trust-root /operator/trust-root.json \
  --release aios-host \
  --version 0.1.0 \
  --commit "$(git rev-parse HEAD)" \
  --profile local-secure
```

The verifier checks the exact archive bytes, artifact-purpose key and validity window, the
release manifest, every file's size and SHA-256, the entrypoint, and the absence of
secret-bearing paths. It never extracts the archive. No auto-update channel exists.

## Contents

- `apps/host/dist/**`
- `packages/*/dist/**`
- `package.json`
- `pnpm-lock.yaml`
- `release-manifest.json` (generated, covered by the signature)

The builder rejects symlinks and secret-bearing paths such as `.env`, private keys, trust
roots, SQLite databases, `.git`, `node_modules` and `.turbo`. The archive is a deterministic
ustar stream with sorted entries, fixed metadata and no timestamps.
