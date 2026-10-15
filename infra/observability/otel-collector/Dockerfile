# Keep the Collector version pinned so infrastructure changes are deliberate and reproducible.
FROM otel/opentelemetry-collector-contrib:0.158.0

COPY config.yaml config.local.yaml config.staging.yaml config.production.template.yaml /etc/otelcol/

ENV PORT=13133

CMD ["--config=/etc/otelcol/config.yaml"]
