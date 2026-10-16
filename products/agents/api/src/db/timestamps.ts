export type DatabaseTimestamp = Date | string;

function timestampMillis(value: DatabaseTimestamp): number | undefined {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

function timestampText(value: DatabaseTimestamp): string {
  return value instanceof Date
    ? (Number.isFinite(value.getTime()) ? value.toISOString() : "")
    : value;
}

/**
 * PostgreSQL's timestamp parser returns Date objects by default. Keep retrieval
 * ordering independent of whether a row came from pg or a test/durable adapter.
 * Invalid values are ordered last instead of turning a read into a runtime
 * exception; the database remains responsible for enforcing valid timestamps.
 */
export function compareDatabaseTimestampsDesc(left: DatabaseTimestamp, right: DatabaseTimestamp): number {
  const leftMillis = timestampMillis(left);
  const rightMillis = timestampMillis(right);
  if (leftMillis !== undefined && rightMillis !== undefined && leftMillis !== rightMillis) {
    return rightMillis - leftMillis;
  }
  if (leftMillis === undefined && rightMillis !== undefined) return 1;
  if (leftMillis !== undefined && rightMillis === undefined) return -1;
  return timestampText(right).localeCompare(timestampText(left));
}
