#!/usr/bin/env bash

set -euo pipefail

pg_restore_bin="${ANALYTICS_PG_RESTORE_BIN:-pg_restore}"
command -v "$pg_restore_bin" >/dev/null 2>&1 || {
  echo "Analytics restore client not found: $pg_restore_bin" >&2
  exit 1
}
: "${ANALYTICS_DATABASE_URL:?Set ANALYTICS_DATABASE_URL for the restore target}"
: "${ANALYTICS_BACKUP_FILE:?Set ANALYTICS_BACKUP_FILE to a custom-format backup}"

if [[ "${ANALYTICS_RESTORE_CONFIRM:-}" != "YES" ]]; then
  echo "Refusing restore: set ANALYTICS_RESTORE_CONFIRM=YES" >&2
  exit 1
fi
if [[ "${ANALYTICS_RESTORE_SERVICES_STOPPED:-}" != "YES" ]]; then
  echo "Refusing restore: stop Analytics API and worker, then set ANALYTICS_RESTORE_SERVICES_STOPPED=YES" >&2
  exit 1
fi
if [[ ! -f "$ANALYTICS_BACKUP_FILE" ]]; then
  echo "Backup file not found: $ANALYTICS_BACKUP_FILE" >&2
  exit 1
fi

if [[ -f "$ANALYTICS_BACKUP_FILE.sha256" ]]; then
  (cd "$(dirname "$ANALYTICS_BACKUP_FILE")" && sha256sum --check "$(basename "$ANALYTICS_BACKUP_FILE.sha256")")
fi

"$pg_restore_bin" \
  --dbname "$ANALYTICS_DATABASE_URL" \
  --format custom \
  --clean \
  --if-exists \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  "$ANALYTICS_BACKUP_FILE"

printf 'Analytics backup restored: %s\n' "$ANALYTICS_BACKUP_FILE"
