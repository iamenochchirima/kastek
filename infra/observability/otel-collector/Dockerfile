# Keep the Collector version pinned so infrastructure changes are deliberate and reproducible.
FROM otel/opentelemetry-collector:0.158.0

COPY config.yaml /etc/otelcol/config.yaml

ENV PORT=13133

CMD ["--config=/etc/otelcol/config.yaml"]
