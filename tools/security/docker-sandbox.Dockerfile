# Minimal, reproducible image for the Docker and gVisor adversarial drills.
#
# The base image is pinned by immutable linux/amd64 manifest digest, not the
# multi-arch index digest: pinning the index alone leaves the platform manifest
# that this build resolves to unpinned. gvisor-rootfs.json records both, and CI
# proves the platform digest is a child of the recorded index
# (`verify-platform-digest`). Apt uses a fixed snapshot.debian.org timestamp; the
# exact top-level package versions are pinned again in the install command. Do not
# replace this with a floating tag or a moving deb.debian.org index.
#
# The image carries only the ordinary POSIX tools the drill invokes. Build-only
# logs, caches and indexes are removed so two independent builds have the same
# filesystem content. /etc/shadow and /etc/gshadow are removed so the host-file-read
# case tests the container rootfs rather than a file that happens to exist in the
# image; it is not a host bind either way.
FROM debian:bookworm-slim@sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018

ENV DEBIAN_FRONTEND=noninteractive \
    LC_ALL=C \
    TZ=UTC \
    SOURCE_DATE_EPOCH=1794268800

RUN set -eux; \
    rm -rf /var/lib/apt/lists/* /etc/apt/sources.list /etc/apt/sources.list.d/*; \
    printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261110T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261110T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261110T000000Z bookworm-security main' \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false update; \
    apt-get install -y --no-install-recommends \
      coreutils=9.1-1 \
      perl=5.36.0-7+deb12u4 \
      util-linux=2.38.1-5+deb12u3; \
    rm -rf /var/lib/apt/lists/* /var/lib/apt/extended_states /var/cache/* /var/log/* \
      /var/lib/dpkg/lock* /var/lib/dpkg/triggers/Lock /tmp/* /var/tmp/* \
      /etc/shadow /etc/gshadow

# The host always supplies argv; this is only a defensive default.
CMD ["/bin/true"]
