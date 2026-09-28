FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
# Temporal's native TLS transport uses the system trust store. The slim image
# does not include CA certificates, so cloud workers otherwise fail with
# NativeCertsNotFound during startup.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Railway API uses 4100; the stateless MCP gateway uses 4200 when this image is
# deployed as a separate service with `node dist/gateway/server.js`.
EXPOSE 4100 4200
CMD ["node", "dist/http/server.js"]
