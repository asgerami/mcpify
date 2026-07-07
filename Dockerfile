# syntax=docker/dockerfile:1

# ---- build stage: install deps, compile TypeScript ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY prebuilt ./prebuilt
RUN npm run build
# Drop dev dependencies so only runtime deps are carried into the final image.
RUN npm prune --omit=dev

# ---- runtime stage: minimal image, non-root ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prebuilt ./prebuilt
COPY package.json ./

# Persist the SQLite database (servers, credentials, tokens, logs) in a volume.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 4000

# Health endpoint for orchestrators / load balancers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
# Bind all interfaces and persist to the volume. Provide MCPIFY_SECRET_KEY,
# MCPIFY_ADMIN_TOKEN, and MCPIFY_PUBLIC_URL via the environment.
CMD ["serve", "--host", "0.0.0.0", "--port", "4000", "--log-db", "/data/mcpify.db", "--rate-limit", "120"]
