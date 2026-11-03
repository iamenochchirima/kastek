import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import type { SupportHours } from "./api";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function normalizeTime(value: string): string {
  const text = value.normalize("NFKC").trim();
  const match = /^(\d{1,2})(?::|\.)(\d{2})$/.exec(text);
  if (match) return `${match[1].padStart(2, "0")}:${match[2]}`;
  if (/^\d{1,2}$/.test(text)) return `${text.padStart(2, "0")}:00`;
  if (/^\d{3,4}$/.test(text)) return `${text.slice(0, -2).padStart(2, "0")}:${text.slice(-2)}`;
  return text;
}
export function normalizeSupportHours(value: SupportHours): SupportHours {
  let timeZone = value.timeZone.normalize("NFKC").trim();
  try { timeZone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone; } catch { /* Invalid input remains editable. */ }
  return { timeZone, intervals: value.intervals.map(item => ({ ...item, start: normalizeTime(item.start), end: normalizeTime(item.end) })) };
}
export function defaultSupportHours(): SupportHours {
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", intervals: [1, 2, 3, 4, 5].map(day => ({ day, start: "09:00", end: "17:00" })) };
}
function periodError(value: SupportHours, index: number): string | undefined {
  const item = value.intervals[index];
  if (!Number.isInteger(item.day) || item.day < 0 || item.day > 6) return "Choose a valid day.";
  if (!time.test(item.start) || !(time.test(item.end) || item.end === "24:00")) return "Enter a valid time, such as 09:00.";
  if (item.start >= item.end) return "Close after opening.";
  if (value.intervals.some((other, n) => n !== index && item.day === other.day && item.start < other.end && other.start < item.end)) return "Hours overlap.";
}
export function validSupportHours(input: SupportHours): boolean {
  const value = normalizeSupportHours(input);
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { return false; }
  return value.timeZone !== "" && value.intervals.length > 0 && value.intervals.length <= 28 && value.intervals.every((_, index) => !periodError(value, index));
}
export function SupportHoursFields({ value, onChange, error }: { value: SupportHours; onChange: (value: SupportHours) => void; error?: string }) {
  const id = useId(), [touched, setTouched] = useState<Set<number>>(() => new Set()), [timezoneTouched, setTimezoneTouched] = useState(false);
  const normalized = normalizeSupportHours(value);
  const update = (index: number, patch: { start?: string; end?: string }) => onChange({ ...value, intervals: value.intervals.map((interval, position) => position === index ? { ...interval, ...patch } : interval) });
  let timezoneError: string | undefined;
  try { if (!normalized.timeZone) throw Error(); new Intl.DateTimeFormat("en", { timeZone: normalized.timeZone }); } catch { timezoneError = "Enter a valid timezone."; }
  const showTimezoneError = !!(error || timezoneTouched) && !!timezoneError;
  const field = (position: number, day: string, side: "start" | "end", suffix = "") => {
    const message = (error || touched.has(position)) && periodError(normalized, position);
    return <Input aria-label={`${day} ${side === "start" ? "opens" : "closes"}${suffix}`} inputMode="numeric" maxLength={16} value={value.intervals[position][side]} aria-invalid={!!message || undefined} aria-describedby={message ? `${id}-${position}` : undefined} onChange={event => update(position, { [side]: event.target.value })} onBlur={event => { setTouched(current => new Set(current).add(position)); update(position, { [side]: normalizeTime(event.target.value) }); }} />;
  };
  const format = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return <fieldset className="space-y-3 border-t pt-4" aria-describedby={error ? "setup-error-supportHours" : undefined}>
    <legend className="text-sm font-medium">Support hours</legend>
    <label className="block max-w-sm space-y-2 text-sm">Timezone<Input value={value.timeZone} maxLength={128} aria-invalid={showTimezoneError || undefined} aria-describedby={showTimezoneError ? `${id}-timezone` : undefined} onChange={event => onChange({ ...value, timeZone: event.target.value })} onBlur={event => { setTimezoneTouched(true); onChange(normalizeSupportHours({ ...value, timeZone: event.target.value })); }} /></label>
    <p id={`${id}-timezone`} className="min-h-4 text-xs text-destructive">{showTimezoneError ? timezoneError : null}</p>
    <div className="space-y-3">{days.map((day, index) => {
      const intervals = value.intervals.map((item, position) => ({ item, position })).filter(entry => entry.item.day === index);
      const lastEnd = normalized.intervals.filter(item => item.day === index).map(item => item.end).sort().at(-1);
      const nextStart = lastEnd && time.test(lastEnd) ? Number(lastEnd.slice(0, 2)) * 60 + Number(lastEnd.slice(3)) : 1440;
      return <div key={day} className="space-y-2 text-sm">
        <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
          <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={intervals.length > 0} onChange={event => onChange({ ...value, intervals: event.target.checked ? [...value.intervals, { day: index, start: "09:00", end: "17:00" }].sort((a,b) => a.day-b.day) : value.intervals.filter(item => item.day !== index) })} />{day}</label>
          {intervals.length ? <>{field(intervals[0].position, day, "start")}{field(intervals[0].position, day, "end")}</> : <><Input aria-label={`${day} opens`} disabled value="" /><Input aria-label={`${day} closes`} disabled value="" /></>}
        </div>
        {intervals.slice(1).map(({ position }, n) => <div key={position} className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"><button type="button" className="text-left text-muted-foreground underline" onClick={() => onChange({...value, intervals:value.intervals.filter((_, i) => i !== position)})}>Remove period</button>{field(position, day, "start", ` ${n + 2}`)}{field(position, day, "end", ` ${n + 2}`)}</div>)}
        {intervals.length ? <div className="flex min-h-5 flex-wrap items-center gap-x-3">
          {value.intervals.length < 28 && nextStart < 1440 ? <button type="button" className="text-xs text-muted-foreground underline" aria-label={`Add ${day} hours`} onClick={() => onChange({...value, intervals:[...value.intervals, { day:index, start:format(nextStart), end:format(Math.min(nextStart + 60, 1440)) }]})}>Add hours</button> : null}
          {intervals.map(({ position }) => <span key={position} id={`${id}-${position}`} className="text-xs text-destructive">{(error || touched.has(position)) ? periodError(normalized, position) : null}</span>)}
        </div> : null}
      </div>;
    })}</div>
    <p className="text-xs text-muted-foreground">24-hour time. Use 24:00 for closing at midnight.</p>
    {error ? <p id="setup-error-supportHours" role="alert" className="text-sm text-destructive">{value.intervals.length ? error : "Select at least one support day."}</p> : null}
  </fieldset>;
}
