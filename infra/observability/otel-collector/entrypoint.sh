#!/bin/sh
set -eu

# The image contains all provider-neutral profiles. Railway selects one by setting
# OTEL_COLLECTOR_CONFIG to a profile filename; local Compose mounts its selected
# profile at the baseline path and leaves this variable unset.
if [ "${1:-}" = "validate" ]; then
  exec /otelcol-contrib "$@"
fi

config="${OTEL_COLLECTOR_CONFIG:-config.yaml}"
case "$config" in
  config.yaml|config.local.yaml|config.staging.yaml|config.production.template.yaml)
    config_path="/etc/otelcol/$config"
    ;;
  /etc/otelcol/config.yaml|/etc/otelcol/config.local.yaml|/etc/otelcol/config.staging.yaml|/etc/otelcol/config.production.template.yaml)
    config_path="$config"
    ;;
  *)
    echo "Unsupported OTEL_COLLECTOR_CONFIG profile: $config" >&2
    exit 64
    ;;
esac

exec /otelcol-contrib --config="$config_path" "$@"
