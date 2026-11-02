#!/bin/sh
set -eu

if [ -z "${RESTATE_SIGNING_PRIVATE_KEY_PEM:-}" ]; then
  echo "RESTATE_SIGNING_PRIVATE_KEY_PEM is required" >&2
  exit 1
fi
umask 077
runtime_directory=$(mktemp -d /tmp/kasitek-restate.XXXXXX)
printf '%s\n' "$RESTATE_SIGNING_PRIVATE_KEY_PEM" > "$runtime_directory/request-identity.pem"
unset RESTATE_SIGNING_PRIVATE_KEY_PEM
cat /etc/kasitek-restate/restate.toml > "$runtime_directory/restate.toml"
printf '\n[worker.invoker]\nrequest-identity-private-key-pem-file = "%s/request-identity.pem"\n' "$runtime_directory" >> "$runtime_directory/restate.toml"
exec /usr/local/bin/restate-server --config-file "$runtime_directory/restate.toml" "$@"
