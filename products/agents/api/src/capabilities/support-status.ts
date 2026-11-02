import { supportHoursSchema, type SupportHours } from "../contracts/customer-setup";

export type SupportStatus = {
  hours: { state: "open" | "closed"; timeZone: string; intervals: SupportHours["intervals"] } | { state: "unknown" };
  staffAvailability: "unknown";
  responseTime: "unknown";
};

/** Hours describe the schedule, not whether a person is available. */
export function supportStatus(value: unknown, now: Date = new Date()): SupportStatus {
  const parsed = supportHoursSchema.safeParse(value);
  if (!parsed.success || !Number.isFinite(now.getTime())) {
    return { hours: { state: "unknown" }, staffAvailability: "unknown", responseTime: "unknown" };
  }
  const schedule = parsed.data;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)?.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday") ?? "");
  const time = `${part("hour")}:${part("minute")}`;
  const open = day >= 0 && schedule.intervals.some(interval => interval.day === day && interval.start <= time && time < interval.end);
  return { hours: { state: open ? "open" : "closed", timeZone: schedule.timeZone, intervals: schedule.intervals }, staffAvailability: "unknown", responseTime: "unknown" };
}
