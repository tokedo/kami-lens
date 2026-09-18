# kami-lens daemon image (DESIGN §5; gate G5.b). Two stages: build packs
# the npm tarball from source; runtime installs exactly that tarball —
# the same artifact a user gets from the registry, nothing more.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm pack

# Stage EXACTLY ONE artifact, by the name package.json dictates, and refuse
# to build if the glob would have been ambiguous.
#
# WHY THIS IS NOT A GLOB ANY MORE: `COPY --from=build /app/kami-lens-*.tgz`
# followed by `npm install -g /tmp/kami-lens-*.tgz` installed EVERY tarball
# in the build context. Two stale ones were tracked in git, so `COPY . .`
# carried them in beside the fresh pack and the installed version came down
# to install ordering — four byte-identical builds produced 0.4.0, 0.2.0,
# 0.1.0 and 0.2.0. The tarballs are now gitignored and dockerignored, and the
# check below means a stray one fails the build instead of winning it.
RUN set -eu; \
    version="$(node -p "require('/app/package.json').version")"; \
    expected="/app/kami-lens-${version}.tgz"; \
    found="$(find /app -maxdepth 1 -name 'kami-lens-*.tgz' | sort)"; \
    count="$(printf '%s' "$found" | grep -c . || true)"; \
    if [ "$count" -ne 1 ]; then \
      echo "FATAL: expected exactly 1 packed tarball in /app, found ${count}:"; \
      echo "$found"; \
      exit 1; \
    fi; \
    if [ "$found" != "$expected" ]; then \
      echo "FATAL: packed artifact ${found} does not match package.json version ${version} (${expected})"; \
      exit 1; \
    fi; \
    cp "$expected" /app/kami-lens.tgz

FROM node:20-slim
COPY --from=build /app/kami-lens.tgz /tmp/kami-lens.tgz
RUN npm install -g /tmp/kami-lens.tgz && rm /tmp/kami-lens.tgz

# and prove what actually landed: the installed CLI must report the version
# the package declares. This is the assertion the version scramble needed —
# it fails the BUILD, not a later run (gate G5.b re-asserts it from outside).
RUN set -eu; \
    installed="$(kami-lens --version | awk '{print $2}')"; \
    expected="$(node -p "require('/usr/local/lib/node_modules/kami-lens/package.json').version")"; \
    if [ "$installed" != "$expected" ]; then \
      echo "FATAL: installed CLI reports ${installed}, package declares ${expected}"; \
      exit 1; \
    fi; \
    echo "installed kami-lens ${installed}"

# state cache + query socket live on the volume (DESIGN §3.5/§5)
ENV KAMI_LENS_DATA_DIR=/data
VOLUME /data

# HEAP CAP, AND IT IS NOT OPTIONAL (0.6.3). A cold boot builds the whole
# ECS image in memory: peak RSS 4.19-4.39 GB measured on the Mac
# (g10a/g10c, 0.6.2) and 3.58-3.83 GB on the VM. Node picks its own
# old-space default from the machine it finds, and in a container that
# default is far below what this needs — measured 2,096 MiB in
# node:20-slim on an 11.65 GiB host, where the zero-config daemon died
# `FATAL ERROR: Ineffective mark-compacts near heap limit` at 2,042 MB,
# 20 s in, 71.9 % through the values apply. Every daemon that has worked
# was started with this flag by hand (the Mac service, and the VM unit at
# 4096 then 6144); the image never set it, and nothing caught that because
# G5.a had not run since 0.2.0, when the world still fit.
#
# 6144 matches the VM unit: ~1.4x the measured peak, and it is a CAP rather
# than a reservation — V8 grows into it lazily, which is why the same boot
# peaks LOWER under a smaller cap (3.58 GB at 6144 on the VM against
# 4.39 GB at 8192 on the Mac). The checkpoint child carries its OWN cap
# (workers/checkpoint/host.ts) and does not draw on this one, so a
# container needs headroom above this for both.
ENV NODE_OPTIONS=--max-old-space-size=6144

# healthy = the daemon answers its own status query with LIVE; the start
# period covers a cold bootstrap (G1.a measured ~44 s; warm ~15 s)
HEALTHCHECK --interval=30s --timeout=15s --start-period=180s --retries=3 \
  CMD kami-lens health || exit 1

ENTRYPOINT ["kami-lens"]
CMD ["daemon"]
