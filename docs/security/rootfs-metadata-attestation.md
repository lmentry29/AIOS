# gVisor rootfs metadata attestation

Status: implemented (host + CI tooling). Verification evidence is recorded in the
validation ledger entry for the commit that introduced manifest v2.

This note defines what the gVisor drill rootfs measurement covers, what it deliberately
normalizes, and which omissions remain. It is the reference for
`digestRootfs` in `apps/host/src/execution/provenance.ts` and the manifest written by
`tools/security/gvisor-provenance.mjs`.

## Why the manifest exists

The gVisor provider hands `runsc` an OCI `root.path` directory. A digest that covered only
file bytes and paths would not notice a changed permission bit, a different owner, or a
`setuid` executable introduced into the tree. Manifest v2 therefore measures the tree that
the runtime is actually given, not merely its file contents.

## Measured fields (manifest v2)

For the root directory and every descendant, in sorted code-unit order:

| Field | Included in `sha256` | Included in `content_sha256` (v1) | Included in `metadata_sha256` | Included in `timestamps_sha256` |
| --- | --- | --- | --- | --- |
| relative path | yes | yes | yes | yes |
| entry type (file, dir, symlink, other) | yes | yes | yes | - |
| permission bits incl. setuid/setgid/sticky | yes | yes (v1 framing) | yes | - |
| owner uid and gid | yes | no | yes | - |
| file size | yes | yes | no | - |
| file content SHA-256 | yes | yes | no | - |
| symlink target | yes | yes | no | - |
| extended attributes (name and value) | yes, when captured | no | yes, when captured | - |
| mtime (nanosecond precision) | no | no | no | yes |

`sha256` is the canonical digest compared by the provider, the rootfs manifest, the
adversarial drill and the adversarial result evidence. `entries` is the number of
descendants (the root itself is measured but not counted, preserving the earlier entry
count semantics).

The manifest also records `manifest_version: 2` and `xattrs: "captured" | "unavailable"`,
so a reader never has to infer whether extended attributes were part of the measurement.

## Normalizations and why they are justified

- **Timestamps are attested separately.** `docker export` does not produce identical
  directory mtimes for two independent `docker build --no-cache` runs, because build steps
  create directories at build time. Requiring mtime equality in `sha256` would make
  independent reproducibility impossible without a normalization step that would itself be
  unaudited. Instead `timestamps_sha256` is recorded and compared when it is meaningful:
  two exports of the same image (`--verify-reproducible`) must match it; two independent
  image builds must match only content and metadata.
- **atime and ctime are excluded.** Reading the tree to hash it changes atime, so an atime
  digest would be self-defeating. ctime changes on any metadata operation and is not stable
  across exports; the security-relevant metadata (mode, owner, size, target, xattrs) is
  already covered by `metadata_sha256`.
- **Ownership is normalized at extraction.** The drill extracts with `tar --no-same-owner`
  so an unprivileged CI runner never receives root-owned `setuid` files. The manifest
  therefore attests the ownership of the tree the runtime is handed. Privilege-relevant
  bits (`setuid`, `setgid`, sticky) are preserved and hashed, so an ownership normalization
  cannot hide an added privilege bit.
- **Directory entry order is normalized by sorting.** Traversal order is a filesystem
  detail, not an artifact property.

## Extended attributes

Node exposes no extended-attribute API. `digestRootfs` reads them through `getfattr`
(`-R -h -d`, sorted per entry) and hashes the attribute lines. `-h` prevents dereferencing
symlinks, so an absolute symlink target inside the rootfs cannot expose host attributes. A
non-zero reader exit is a hard failure unless every reported error is `Operation not
supported`, which is how GNU getfattr reports entries (notably symlinks on ext4/overlayfs)
that cannot carry the attributes at all; those entries are attested with an empty attribute
set. Any other error, including a permission failure, aborts the measurement. If the reader is
missing:

- `xattrs: 'auto'` (default) records `xattrs: "unavailable"` in the digest and manifest, so
  the omission is visible and changes the canonical digest.
- `xattrs: 'required'` fails closed before hashing. The Security workflow installs `attr`
  and passes `--require-xattrs` when it builds the evidence rootfs, so the published
  evidence cannot silently omit extended attributes.

Local runs without `attr` still measure content, mode, ownership and timestamps, and the
manifest says so.

## Platform digest binding

`tools/security/gvisor-rootfs.json` records both the multi-arch index digest and the
`linux/amd64` manifest digest. `tools/security/docker-sandbox.Dockerfile` uses the platform
digest in `FROM`, and `verifyGvisorRootfsBuildInputs` rejects any other base. CI additionally
runs `verify-platform-digest`, which selects the single `linux/amd64` entry from the raw
pinned index and requires it to equal the recorded platform digest. Pinning the index alone
would leave the resolved platform manifest unpinned.

## Verify-to-execute binding

- The provider hashes the PATH-resolved `runsc`, then materializes `runsc` and its
  `gvisor-bin/` Sentry sidecars into a private `mkdtemp` directory (mode `0700`; the executable
  is `0500`), rejects symlinks and special files in the copy, re-hashes the copied `runsc`, and
  executes the copy. `runsc` resolves its sidecars relative to its own executable, so the whole
  runtime tree has to move with it. Replacing the PATH entry after verification cannot change
  what runs.
- `assertMaterializedExecutableUnchanged` re-checks inode, size, writability and SHA-256
  immediately before execution. The remaining window is confined to a directory only the
  invoking user can write; a same-UID attacker is inside the host trust boundary.
- The rootfs is measured before execution and re-measured after it. A difference rejects the
  result with `SandboxIsolationUnavailableError`; the outcome is not attributed to the
  verified tree.

## Remaining omissions and residuals

- Extended attributes are not attested on hosts without an xattr reader; the manifest marks
  this and CI requires the reader.
- `runsc`'s own runtime state directory is deleted after every invocation, but a host-level
  writer with the invoking user's privileges can still influence the process, pin files and
  rootfs between operations. This is why the host is the trust root and why same-UID
  compromise is out of scope rather than claimed as defended.
- The Debian snapshot used by the image build must remain available for a future rebuild.
- Pins, the build manifest and the rootfs manifest are not yet signed; that is tracked as
  F-017 and is not claimed as complete by this note.
