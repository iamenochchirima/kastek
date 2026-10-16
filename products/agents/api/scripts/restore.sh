#!/usr/bin/env bash

set -euo pipefail

pg_restore_bin="${AGENTS_PG_RESTORE_BIN:-}"
if [[ -n "$pg_restore_bin" ]] && ! command -v "$pg_restore_bin" >/dev/null 2>&1; then
  echo "Agents restore client not found: $pg_restore_bin" >&2
  exit 1
fi
: "${AGENTS_DATABASE_URL:?Set AGENTS_DATABASE_URL for the restore target}"
: "${AGENTS_BACKUP_FILE:?Set AGENTS_BACKUP_FILE to a custom-format backup}"

if [[ "${AGENTS_RESTORE_CONFIRM:-}" != "YES" ]]; then
  echo "Refusing restore: set AGENTS_RESTORE_CONFIRM=YES" >&2
  exit 1
fi
if [[ "${AGENTS_RESTORE_SERVICES_STOPPED:-}" != "YES" ]]; then
  echo "Refusing restore: stop Agents API and workers, then set AGENTS_RESTORE_SERVICES_STOPPED=YES" >&2
  exit 1
fi
if [[ ! -f "$AGENTS_BACKUP_FILE" ]]; then
  echo "Backup file not found: $AGENTS_BACKUP_FILE" >&2
  exit 1
fi

if [[ -z "$pg_restore_bin" ]]; then
  pg_restore_bin="pg_restore"
  metadata_file="$AGENTS_BACKUP_FILE.metadata"
  if [[ -f "$metadata_file" ]]; then
    pg_dump_version="$(awk -F= '$1 == "pg_dump_version" { print substr($0, index($0, "=") + 1); exit }' "$metadata_file")"
    if [[ "$pg_dump_version" =~ ([0-9]+)\. ]]; then
      matching_restore="/usr/lib/postgresql/${BASH_REMATCH[1]}/bin/pg_restore"
      if [[ -x "$matching_restore" ]]; then pg_restore_bin="$matching_restore"; fi
    fi
  fi
fi
command -v "$pg_restore_bin" >/dev/null 2>&1 || {
  echo "Agents restore client not found: $pg_restore_bin" >&2
  exit 1
}

if [[ -f "$AGENTS_BACKUP_FILE.sha256" ]]; then
  (cd "$(dirname "$AGENTS_BACKUP_FILE")" && sha256sum --check "$(basename "$AGENTS_BACKUP_FILE.sha256")")
fi

if [[ ! -s "$AGENTS_BACKUP_FILE" ]]; then
  echo "Refusing restore: backup archive is empty" >&2
  exit 1
fi
"$pg_restore_bin" --list "$AGENTS_BACKUP_FILE" >/dev/null

"$pg_restore_bin" \
  --dbname "$AGENTS_DATABASE_URL" \
  --format custom \
  --clean \
  --if-exists \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  "$AGENTS_BACKUP_FILE"

printf 'Agents backup restored: %s\n' "$AGENTS_BACKUP_FILE"
