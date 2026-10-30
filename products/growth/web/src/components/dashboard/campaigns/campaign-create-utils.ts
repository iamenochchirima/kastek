/** Resolve a wall-clock time without silently normalizing DST gaps or overlaps. */
export function scheduledInstants(local: string, timeZone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return [];
  const [year, month, day, hour, minute] = local.split(/\D/).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).toISOString().slice(0, 16) !== local) return [];
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const partsAt = (instant: number) =>
      Object.fromEntries(
        formatter.formatToParts(instant).map((part) => [part.type, part.value]),
      );
    const offsets = new Set<number>();
    // Sampling either side includes both offsets around timezone transitions.
    for (const delta of [-48, -24, 0, 24, 48]) {
      const probe = wall + delta * 3600000;
      const p = partsAt(probe);
      offsets.add(
        Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - probe,
      );
    }
    return [...offsets]
      .map((offset) => wall - offset)
      .filter((instant) => {
        const p = partsAt(instant);
        return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === local;
      })
      .sort((a, b) => a - b)
      .map((instant) => new Date(instant).toISOString());
  } catch {
    return [];
  }
}

export function timeZoneOptions(current: string) {
  const zones = Intl.supportedValuesOf("timeZone");
  return [...new Set([current, "UTC", ...zones])];
}
