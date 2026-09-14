# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
# Pinned to $BUILDPLATFORM deliberately: tsc emits platform-independent
# JavaScript, so there is no reason to run the compiler under QEMU when the
# target is arm64 for a Raspberry Pi. Only dist/ crosses into the runtime stage,
# and dist/ is plain .js -- no node_modules from this stage is ever copied out.
ARG NODE_IMAGE=node:26-alpine
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build

WORKDIR /app

# NODE_ENV is left unset here on purpose so `npm ci` installs devDependencies;
# typescript is the only one the build actually needs.
COPY package.json package-lock.json ./
RUN npm ci --no-audit

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----------------------------------------------------------------
# node:26-alpine matches the runtime and types validated in CI. SQLite comes
# from Node's built-in node:sqlite, so the image needs no python3/make/g++ and
# nothing is compiled at install time. That keeps the arm64 build for a
# Raspberry Pi fast and toolchain-free.
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/board.db

WORKDIR /app

# Runtime dependencies only -- typescript, eslint and prettier never ship. This
# resolves natively for the target platform rather than copying node_modules
# across from the build stage.
COPY package.json package-lock.json ./
# Patch base OS packages, then remove package managers that the running board
# never invokes. This also removes their unrelated dependency attack surface.
RUN apk upgrade --no-cache \
    && npm ci --omit=dev --no-audit \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The compiled server. public/ is served as-is and is never compiled, so it is
# copied from the context rather than from the build stage.
COPY --from=build /app/dist ./dist
COPY public ./public
COPY LICENSE THIRD-PARTY-LICENSES.md ./

# /data holds the SQLite database and the advisory details.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --enable-source-maps so the sourceMap output actually improves stack traces.
CMD ["node", "--enable-source-maps", "dist/src/server.js"]
