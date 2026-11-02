/** Interpret the datetime-local field in the browser timezone, then send an explicit UTC instant. */
export function scheduledPostTimestamp(value: string, now = Date.now()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid scheduled time");
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute)
    throw new Error("Choose a valid scheduled time");
  if (date.getTime() <= now) throw new Error("Choose a scheduled time in the future");
  return date.toISOString();
}
