# kami-lens daemon image (DESIGN §5; gate G5.b). Two stages: build packs
# the npm tarball from source; runtime installs exactly that tarball —
# the same artifact a user gets from the registry, nothing more.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm pack

FROM node:20-slim
COPY --from=build /app/kami-lens-*.tgz /tmp/
RUN npm install -g /tmp/kami-lens-*.tgz && rm /tmp/kami-lens-*.tgz

# state cache + query socket live on the volume (DESIGN §3.5/§5)
ENV KAMI_LENS_DATA_DIR=/data
VOLUME /data

# healthy = the daemon answers its own status query with LIVE; the start
# period covers a cold bootstrap (G1.a measured ~44 s; warm ~15 s)
HEALTHCHECK --interval=30s --timeout=15s --start-period=180s --retries=3 \
  CMD kami-lens health || exit 1

ENTRYPOINT ["kami-lens"]
CMD ["daemon"]
