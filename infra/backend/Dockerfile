# Build from the monorepo root. Use SERVICE_PACKAGE and SERVICE_PATH from the runbook.
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
COPY . .
ARG SERVICE_PACKAGE=@kasitek/growth-core
ARG SERVICE_PATH=products/growth/api
RUN case "$SERVICE_PACKAGE:$SERVICE_PATH" in \
      @kasitek/growth-core:products/growth/api|\
      @kasitek/agency-tenants:products/agency/api|\
      @kasitek/analytics:services/analytics|\
      @kasitek/operations:services/operations) ;; \
      *) echo 'Unsupported backend package/path pair' >&2; exit 1 ;; \
    esac \
    && pnpm --filter @kasitek/workspace --filter "$SERVICE_PACKAGE..." install --frozen-lockfile \
    && pnpm --filter "$SERVICE_PACKAGE..." build \
    && pnpm --filter "$SERVICE_PACKAGE" deploy --legacy --prod /out \
    && mkdir -p /out/dist \
    && cp -R "$SERVICE_PATH/dist/." /out/dist/ \
    && for directory in migrations sql contracts metrics; do \
      if [ -d "$SERVICE_PATH/$directory" ]; then \
        mkdir -p "/out/$directory"; cp -R "$SERVICE_PATH/$directory/." "/out/$directory/"; \
      fi; \
    done

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 TZ=UTC
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out/ ./
USER node
# Analytics and Operations override this with their API or worker entry point.
CMD ["node", "dist/bootstrap.js"]
