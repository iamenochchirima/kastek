# Build context is the monorepo root. No identity or provider secrets enter this image.
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
COPY . .
RUN pnpm --filter client... install --frozen-lockfile
ARG VITE_META_APP_ID
ARG VITE_META_EMBEDDED_SIGNUP_CONFIG_ID
RUN pnpm --filter @kasitek-labs/contracts build && pnpm --filter client build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/products/growth/web/build/client ./build/client
COPY --from=build --chown=node:node /workspace/products/growth/web/scripts/serve.mjs ./scripts/serve.mjs
COPY --from=build --chown=node:node /workspace/products/growth/web/scripts/route-contract.json ./scripts/route-contract.json
USER node
EXPOSE 3000
CMD ["node", "scripts/serve.mjs"]
