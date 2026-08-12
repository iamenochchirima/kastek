FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Railway API uses 4100; the stateless MCP gateway uses 4200 when this image is
# deployed as a separate service with `node dist/gateway/server.js`.
EXPOSE 4100 4200
CMD ["node", "dist/http/server.js"]
