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
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
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

FROM node:22-alpine AS runner
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
USER node
EXPOSE 3000
CMD ["node", "server.js"]
