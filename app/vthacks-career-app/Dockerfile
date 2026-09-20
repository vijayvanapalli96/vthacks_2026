# The public deployment of the web app, for the Vultr host behind Caddy.
#
# Databricks Apps is NOT usable for the public site: its edge redirects every
# anonymous request to the workspace OAuth login, so a visitor without a
# Databricks account never reaches our own Auth.js sign-in. The app keeps
# running there for internal use; hirewire.biz is served from here.
#
# Uses next.config.ts `output: 'standalone'`, whose generated server.js honours
# PORT/HOSTNAME — server.mjs exists for the Databricks Apps runtime and adds
# nothing here.
#
# DEBIAN SLIM, NOT ALPINE, AND THAT IS LOAD-BEARING. The mock interview room's
# steadiness read uses @smartspectra/node-sdk, whose native payload is built
# against glibc. On Alpine's musl it installs cleanly and then fails to load at
# runtime — the feature would be silently off in production and perfectly fine in
# dev. The image is bigger; a feature that only works on the developer's machine
# is worse. Everything else in the app is indifferent to the base.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# Next puts the standalone bundle under the inferred workspace root, so a stray
# lockfile in a parent directory moves server.js into a subdirectory and the
# COPY below would silently produce an image that exits on start. .dockerignore
# keeps the context clean; this makes the failure loud if that ever slips.
RUN test -f .next/standalone/server.js || { echo "standalone server.js is not at .next/standalone/ - check for a stray lockfile above the app"; find .next/standalone -name server.js; exit 1; }

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The standalone bundle ships its own traced node_modules; static assets and
# public/ are not part of it and have to be laid in beside it.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# The Presage SDK, by hand, because nothing else can put it here.
#
# It is imported through a variable specifier (see src/lib/presage.ts) so neither
# the bundler nor Next's file tracing can see it, and it reaches koffi and
# protobufjs through runtime `require` so naming it in outputFileTracingIncludes
# is not enough either — that shipped a container that failed with "Cannot find
# module 'koffi'". Copied from the deps stage, where `npm ci` already picked the
# one native payload matching this platform.
#
# If the steadiness read ever goes quiet in production, the first check is:
#   docker exec hirewire-app-1 node -e "import('@smartspectra/node-sdk').then(()=>console.log('ok'))"
COPY --from=deps /app/node_modules/@smartspectra ./node_modules/@smartspectra
COPY --from=deps /app/node_modules/koffi ./node_modules/koffi
COPY --from=deps /app/node_modules/protobufjs ./node_modules/protobufjs
COPY --from=deps /app/node_modules/@protobufjs ./node_modules/@protobufjs
COPY --from=deps /app/node_modules/long ./node_modules/long
USER node
EXPOSE 3000
CMD ["node", "server.js"]
