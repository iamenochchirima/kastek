# Keep the Collector version pinned so infrastructure changes are deliberate and reproducible.
FROM otel/opentelemetry-collector-contrib:0.158.0

COPY config.yaml config.local.yaml config.staging.yaml config.production.template.yaml /etc/otelcol/
COPY entrypoint.sh /usr/local/bin/kasitek-otelcol

RUN chmod 0555 /usr/local/bin/kasitek-otelcol

ENV PORT=13133

ENTRYPOINT ["/usr/local/bin/kasitek-otelcol"]
