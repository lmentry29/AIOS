# Minimal, reproducible image for the Docker adversarial drill.
#
# The image carries only the ordinary POSIX tools the drill invokes. /etc/shadow is
# removed so the host-file-read case tests the container rootfs rather than a file that
# happens to exist in the image; it is not a host bind either way.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends perl coreutils util-linux \
  && rm -rf /var/lib/apt/lists/* /etc/shadow /etc/gshadow

# The host always supplies argv; this is only a defensive default.
CMD ["/bin/true"]
