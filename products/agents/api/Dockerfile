# Build from the monorepo root: docker build -f products/agents/api/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
# The root .dockerignore allows only manifests and Agents/shared build inputs.
COPY . .
RUN pnpm --filter @kasitek/workspace --filter @kasitek/agents... install --frozen-lockfile
RUN pnpm --filter @kasitek/agents... build
RUN pnpm --filter @kasitek/agents deploy --legacy --prod /out
# Explicit copies retain runtime files even if source ignore rules omit build output.
RUN mkdir -p /out/dist /out/schema && cp -R products/agents/api/dist/. /out/dist/ && cp -R products/agents/api/schema/. /out/schema/

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# Provider connections use the operating system trust store.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/schema ./schema
EXPOSE 4100 9080
USER node
CMD ["node", "dist/composition/server.js"]
