# Build from the repository root. Copy only frontend inputs, never backend .env files.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/apps/agent-platform/package.json ./client/apps/agent-platform/package.json
RUN pnpm install --filter @kasitek/agent-platform --frozen-lockfile
COPY client/apps/agent-platform ./client/apps/agent-platform
RUN pnpm --filter @kasitek/agent-platform build

FROM nginx:stable-alpine AS runtime
ENV AGENTS_API_UPSTREAM=http://api:4100
ENV NGINX_ENVSUBST_FILTER=AGENTS_API_UPSTREAM
COPY client/apps/agent-platform/hosting/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/client/apps/agent-platform/dist /usr/share/nginx/html
EXPOSE 8080
