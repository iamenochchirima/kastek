# Build from the monorepo root: docker build -f products/agents/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
# The root .dockerignore allows only manifests and Agents/shared build inputs.
COPY . .
RUN pnpm --filter @kasitek/workspace --filter @kasitek/agents... install --frozen-lockfile
RUN pnpm --filter @kasitek-labs/contracts build
RUN pnpm --filter @kasitek/agents build
RUN pnpm --filter @kasitek/agents deploy --legacy --prod /out
# Explicit copies retain runtime files even if source ignore rules omit build output.
RUN mkdir -p /out/dist /out/migrations && cp -R products/agents/dist/. /out/dist/ && cp -R products/agents/migrations/. /out/migrations/
RUN node -e "require('/out/node_modules/@kasitek-labs/contracts')"

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Temporal uses the operating system trust store.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/migrations ./migrations
EXPOSE 4100 4200
CMD ["node", "dist/http/server.js"]
