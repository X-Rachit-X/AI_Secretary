# CortexOne — one container that serves the API and the built frontend.
#
# Three stages, and the reason for each:
#
#   deps    install every dependency, including dev ones, because TypeScript
#           and Vite are needed to build
#   build   compile the server to dist/ and the web app to web/dist/
#   runtime start from a clean base and copy in ONLY what runs
#
# The split matters: the final image has no TypeScript compiler, no Vite, and
# no source files. Smaller to ship, and a much smaller surface to attack.

# ─────────────────────────────────────────────────────────────── deps ────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy manifests only, so this layer is cached and `npm ci` is skipped on any
# rebuild that did not change a dependency. Copying source first would bust
# the cache on every edit.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN npm ci --workspaces --include-workspace-root

# ────────────────────────────────────────────────────────────── build ────────
FROM node:22-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY . .

# Prisma generates a platform-specific query engine, so this must run inside
# the image rather than being copied from a host build.
RUN npx prisma generate --schema=server/prisma/schema.prisma

RUN npm run build -w server
RUN npm run build -w web

# Drop dev dependencies now that compilation is finished. The generated Prisma
# client lives in node_modules, so it has to survive this prune — it does,
# because @prisma/client is a production dependency.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ──────────────────────────────────────────────────────────── runtime ────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV SERVE_WEB=true
ENV WEB_DIST_PATH=/app/web/dist
ENV PORT=4000

# Run as a non-root user. node:alpine already defines uid 1000 "node".
RUN mkdir -p /app/server/storage /app/server/tmp \
    && chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/prisma ./server/prisma
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node

WORKDIR /app/server

EXPOSE 4000

# Fails the container health check if the database is unreachable, so an
# orchestrator restarts or stops routing to a broken instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `prisma migrate deploy` applies committed migrations and is safe to run on
# every boot: already-applied migrations are skipped. Never `db push` in
# production — it can drop columns to match the schema.
CMD ["sh", "-c", "npx prisma migrate deploy --schema=prisma/schema.prisma && node dist/index.js"]
