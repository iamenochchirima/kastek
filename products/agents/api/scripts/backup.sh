#!/usr/bin/env bash

set -euo pipefail
umask 077

pg_dump_bin="${AGENTS_PG_DUMP_BIN:-pg_dump}"
command -v "$pg_dump_bin" >/dev/null 2>&1 || {
  echo "Agents backup client not found: $pg_dump_bin" >&2
  exit 1
}
: "${AGENTS_DATABASE_URL:?Set AGENTS_DATABASE_URL before creating a backup}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
backup_dir="${AGENTS_BACKUP_DIR:-$script_dir/../.backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_id="agents-$timestamp"
backup_file="$backup_dir/$backup_id.dump"
metadata_file="$backup_file.metadata"

mkdir -p "$backup_dir"
temporary_backup_file="$(mktemp "$backup_dir/.${backup_id}.XXXXXX.dump")"
cleanup_temporary_backup() {
  rm -f -- "$temporary_backup_file"
}
trap cleanup_temporary_backup EXIT
"$pg_dump_bin" \
  --dbname "$AGENTS_DATABASE_URL" \
  --format custom \
  --no-owner \
  --no-privileges \
  --file "$temporary_backup_file"

if [[ ! -s "$temporary_backup_file" ]]; then
  echo "Agents backup is empty; refusing to publish it: $backup_file" >&2
  exit 1
fi
mv -- "$temporary_backup_file" "$backup_file"
trap - EXIT

sha256sum "$backup_file" > "$backup_file.sha256"
git_revision="$(git -C "$repository_root" rev-parse HEAD 2>/dev/null || printf 'unknown')"
pg_dump_version="$("$pg_dump_bin" --version)"
migration_target="$(find "$repository_root/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort | tail -1 | cut -d_ -f1)"
if [[ -z "$migration_target" ]]; then
  migration_target="unknown"
fi
{
  printf 'backup_id=%s\n' "$backup_id"
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'format=postgres-custom\n'
  printf 'pg_dump_version=%s\n' "$pg_dump_version"
  printf 'git_revision=%s\n' "$git_revision"
  printf 'migration_target=%s\n' "$migration_target"
  printf 'backup_file=%s\n' "$(basename "$backup_file")"
} > "$metadata_file"

printf 'Agents backup created: %s\n' "$backup_file"
printf 'Backup ID: %s\n' "$backup_id"
