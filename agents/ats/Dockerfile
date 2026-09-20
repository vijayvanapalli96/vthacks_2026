# Playwright's own image: it carries Chromium plus the system libraries the
# browser needs. node:22-alpine (used by the other two agents) cannot run
# Chromium, so this service deliberately does not match their base image.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /app
COPY ats ./ats
COPY shared ./shared

# The browser is already in the image; this is only the Playwright client.
RUN npm install --no-save playwright@1.56.0

# Artifacts (filled-form screenshots, would-submit records) land here. Mounted as
# a volume in compose so a review can outlive a container restart.
RUN mkdir -p /app/work/ats /app/audit

# Drop the root privileges the base image starts with — this process opens
# attacker-influenced URLs in a browser, which is exactly where you want a
# non-root user.
USER pwuser

EXPOSE 8789
CMD ["node", "ats/server.mjs"]
