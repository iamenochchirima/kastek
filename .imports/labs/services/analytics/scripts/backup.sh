#!/usr/bin/env bash

set -euo pipefail
umask 077

pg_dump_bin="${ANALYTICS_PG_DUMP_BIN:-pg_dump}"
command -v "$pg_dump_bin" >/dev/null 2>&1 || {
  echo "Analytics backup client not found: $pg_dump_bin" >&2
  exit 1
}
: "${ANALYTICS_DATABASE_URL:?Set ANALYTICS_DATABASE_URL before creating a backup}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
backup_dir="${ANALYTICS_BACKUP_DIR:-$SCRIPT_DIR/../.backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_dir/analytics-$timestamp.dump"
metadata_file="$backup_file.metadata"

mkdir -p "$backup_dir"
"$pg_dump_bin" \
  --dbname "$ANALYTICS_DATABASE_URL" \
  --format custom \
  --no-owner \
  --no-privileges \
  --file "$backup_file"

sha256sum "$backup_file" > "$backup_file.sha256"
git_revision="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
{
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'format=postgres-custom\n'
  printf 'git_revision=%s\n' "$git_revision"
  printf 'backup_file=%s\n' "$(basename "$backup_file")"
} > "$metadata_file"

printf 'Analytics backup created: %s\n' "$backup_file"
