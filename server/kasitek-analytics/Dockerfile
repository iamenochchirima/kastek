FROM rust:1.88-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY kasitek-core ./kasitek-core
COPY kasitek-analytics ./kasitek-analytics
COPY kasitek-tenants ./kasitek-tenants

RUN cargo build --release -p kasitek-analytics --bins

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/analytics-api /usr/local/bin/analytics-api
COPY --from=builder /build/target/release/analytics-worker /usr/local/bin/analytics-worker
COPY --from=builder /build/target/release/analytics-migrate /usr/local/bin/analytics-migrate

ENV ANALYTICS_API_HOST=0.0.0.0
ENV ANALYTICS_API_PORT=4300

EXPOSE 4300
ENTRYPOINT ["/usr/local/bin/analytics-api"]
