#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v pg_isready >/dev/null 2>&1 || {
  echo "pg_isready from the PostgreSQL client tools is required" >&2
  exit 1
}

cd "$SERVICE_DIR"
DB_LOCATION_RAW="$(node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
const local = existsSync(".env") ? parse(readFileSync(".env", "utf8")) : {};
const raw = process.env.ANALYTICS_DATABASE_URL || local.ANALYTICS_DATABASE_URL;
if (!raw) process.exit(2);
const url = new URL(raw);
process.stdout.write(`${url.hostname}\n${url.port || "5432"}\n${url.pathname.replace(/^\\//, "")}\n`);
')" || {
  echo "Set ANALYTICS_DATABASE_URL or add it to services/analytics/.env" >&2
  exit 1
}
readarray -t DB_LOCATION <<< "$DB_LOCATION_RAW"
PG_HOST="${DB_LOCATION[0]}"
PG_PORT="${DB_LOCATION[1]}"
PG_DATABASE="${DB_LOCATION[2]}"
pg_isready --host "$PG_HOST" --port "$PG_PORT" --dbname "$PG_DATABASE"
echo "PostgreSQL is reachable. Analytics local development uses native PostgreSQL; Redis is optional."
