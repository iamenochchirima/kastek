/** Validate report timestamp fields and preserve nanoseconds in normalized UTC. */
export function parseChronoTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected timestamp");
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|UTC|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) throw new Error("expected RFC3339 timestamp");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  )
    throw new Error("invalid calendar timestamp");

  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z" && zone.toUpperCase() !== "UTC") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(-2));
    if (offsetHours > 23 || offsetRemainder > 59)
      throw new Error("invalid timezone offset");
    const sign = zone[0] === "+" ? 1 : -1;
    offsetMinutes = sign * (offsetHours * 60 + offsetRemainder);
  }

  const fraction = (match[7] ?? "").slice(0, 9).padEnd(9, "0");
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(
    hour,
    minute,
    second === 60 ? 59 : second,
    Number(fraction.slice(0, 3)),
  );
  const utc = new Date(
    instant.getTime() + (second === 60 ? 1000 : 0) - offsetMinutes * 60_000,
  );
  if (!Number.isFinite(utc.getTime())) throw new Error("invalid timestamp");

  const timestampDate = second === 60 ? new Date(utc.getTime() - 1000) : utc;
  const formatted = timestampDate.toISOString().replace(/\.\d{3}Z$/, "");
  const timestamp = second === 60 ? formatted.replace(/:59$/, ":60") : formatted;
  const nanoseconds = Number(fraction);
  const precision =
    nanoseconds === 0
      ? 0
      : nanoseconds % 1_000_000 === 0
        ? 3
        : nanoseconds % 1_000 === 0
          ? 6
          : 9;
  return `${timestamp}${precision ? `.${fraction.slice(0, precision)}` : ""}Z`;
}
