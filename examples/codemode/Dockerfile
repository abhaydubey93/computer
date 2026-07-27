# Container image for the container example.
#
# Pulls the wsd binary out of the public GHCR image. That image is
# a single layer over `scratch` whose only contents are the SEA
# binary at /usr/local/bin/wsd; we COPY it into a slim debian
# runtime below. The :VERSION tag is rewritten in lockstep with
# the rest of the monorepo by script/set-versions.mjs.
#
# wsd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# see the same VFS the RPC surface reads and writes. With
# FUSE_MOUNT=auto (below) the same image works in both directions:
# Cloudflare Containers expose /dev/fuse to the workload, so the
# real FUSE backend mounts; `wrangler dev` doesn't, so wsd falls
# back to the userspace shim transparently.
#
# Node comes from Debian's own package repository, not from the
# NodeSource repository. The examples/container image installs
# NodeSource's build of Node 22 over HTTPS, but that fetch fails
# behind a network that intercepts TLS with its own certificate
# authority (the curl to deb.nodesource.com aborts with a
# self-signed-certificate error). The Debian mirror is served over
# plain HTTP, so installing Debian's `nodejs` and `npm` builds in
# those environments too. The tradeoff is an older Node than
# NodeSource ships; fine for exercising the container backend.

FROM ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.11 AS wsd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates git nodejs npm \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd

# wsd's defaults: HTTP+WS on :8080, FUSE mount on MOUNT_POINT.
# FUSE_MOUNT=auto picks real FUSE on Cloudflare Containers (where
# /dev/fuse is exposed) and the userspace shim under wrangler dev.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
