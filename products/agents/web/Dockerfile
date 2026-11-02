# Build from the monorepo root. Backend secrets are excluded from the context.
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
COPY . .
RUN pnpm --filter @kasitek/workspace --filter @kasitek/agent-platform... install --frozen-lockfile
RUN pnpm --filter @kasitek/agent-platform build

FROM nginx:stable-alpine AS runtime
ENV AGENTS_API_UPSTREAM=http://api:4100
ENV NGINX_ENVSUBST_FILTER=AGENTS_API_UPSTREAM
COPY products/agents/web/hosting/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/products/agents/web/dist /usr/share/nginx/html
EXPOSE 8080
