# Glass Bank container image (block: infra).
#
# Multi-stage on node:22-slim (docs/ARCHITECTURE.md section 3; Node 22 LTS is the container target
# even though the Mac runs Node 23.10 locally, assumption A-18). Built from the repository root:
#   docker build -f infra/Dockerfile -t <image> .
# Cloud Build runs exactly that through infra/cloudbuild.yaml, because `gcloud builds submit --tag`
# only finds a Dockerfile at the context root.

# ---------- build stage -------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuilt binary matches the platform
# or the Node ABI; python3, make and g++ are what node-gyp needs. They stay in this stage only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first so the layer is cached while only sources change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies; the compiled better-sqlite3 binding built above is kept.
RUN npm prune --omit=dev

# ---------- runtime stage -----------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

# NODE_ENV is deliberately not baked in: Cloud Run sets NODE_ENV=production through --set-env-vars
# (docs/DEPLOYMENT.md section 1.2), and leaving it unset lets `docker run` boot locally for a smoke
# test without a real OAUTH_SIGNING_KEY.
ENV NODE_OPTIONS=--enable-source-maps \
    PORT=8080

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json

# The dashboard. `src/composition.ts` resolves `dashboardRoot` to `<app>/public`, so without this
# every /xray path 404s in the deployed service and the link `xray_get_session_link` hands the user
# leads nowhere. `infra/smoke.sh` asserts /xray/ and /xray/app.js so it cannot regress silently.
COPY --chown=node:node public ./public
# `public/fixtures` is a relative symlink to `../test/fixtures`, and COPY preserves it as a symlink
# rather than following it. Recreating the layout it points at keeps `/xray/?fixture=1` working in
# the container exactly as it does in the source tree. `.dockerignore` re-includes this one path.
COPY --chown=node:node test/fixtures ./test/fixtures

# The node:22-slim image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 8080
CMD ["node", "dist/server.js"]
