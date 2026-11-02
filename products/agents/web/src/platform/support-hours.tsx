import { Input } from "@/components/ui/input";
import type { SupportHours } from "./api";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function defaultSupportHours(): SupportHours {
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "", intervals: [] };
}

export function validSupportHours(value: SupportHours): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { return false; }
  return value.timeZone.trim() !== "" && value.intervals.length > 0 && value.intervals.length <= 28 && value.intervals.every((item, index) =>
    time.test(item.start) && (time.test(item.end) || item.end === "24:00") && item.start < item.end &&
    value.intervals.every((other, otherIndex) => index === otherIndex || item.day !== other.day || item.end <= other.start || other.end <= item.start));
}

export function SupportHoursFields({ value, onChange, error }: { value: SupportHours; onChange: (value: SupportHours) => void; error?: string }) {
  const update = (index: number, patch: { start?: string; end?: string }) => onChange({ ...value,
    intervals: value.intervals.map((interval, position) => position === index ? { ...interval, ...patch } : interval) });
  return <fieldset className="space-y-3 border-t pt-4" aria-describedby={error ? "setup-error-supportHours" : undefined}>
    <legend className="text-sm font-medium">Support hours</legend>
    <label className="block max-w-sm space-y-2 text-sm">Timezone<Input value={value.timeZone} placeholder="Africa/Johannesburg" onChange={event => onChange({ ...value, timeZone: event.target.value })} /></label>
    <div className="space-y-2">{days.map((day, index) => {
      const intervals = value.intervals.map((item, position) => ({ item, position })).filter(entry => entry.item.day === index);
      return <div key={day} className="space-y-2 text-sm">
        <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
          <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={intervals.length > 0} onChange={event => onChange({ ...value, intervals: event.target.checked ? [...value.intervals, { day: index, start: "", end: "" }].sort((a,b) => a.day-b.day) : value.intervals.filter(item => item.day !== index) })} />{day}</label>
          <Input aria-label={`${day} opens`} placeholder="09:00" disabled={!intervals.length} value={intervals[0]?.item.start ?? ""} onChange={event => update(intervals[0]!.position, { start: event.target.value })} />
          <Input aria-label={`${day} closes`} placeholder="17:00" disabled={!intervals.length} value={intervals[0]?.item.end ?? ""} onChange={event => update(intervals[0]!.position, { end: event.target.value })} />
        </div>
        {intervals.slice(1).map(({item, position}, n) => <div key={position} className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"><button type="button" className="text-left text-muted-foreground underline" onClick={() => onChange({...value, intervals:value.intervals.filter((_, i) => i !== position)})}>Remove period</button><Input aria-label={`${day} opens ${n + 2}`} value={item.start} onChange={event => update(position, { start:event.target.value })} /><Input aria-label={`${day} closes ${n + 2}`} value={item.end} onChange={event => update(position, { end:event.target.value })} /></div>)}
        {intervals.length > 0 && value.intervals.length < 28 ? <button type="button" className="text-xs text-muted-foreground underline" aria-label={`Add ${day} hours`} onClick={() => onChange({...value, intervals:[...value.intervals, { day:index, start:"", end:"" }]})}>Add hours</button> : null}
      </div>;
    })}</div>
    <p className="text-xs text-muted-foreground">Use 24-hour time. For midnight, enter 24:00.</p>
    {error ? <p id="setup-error-supportHours" role="alert" className="text-sm text-destructive">{error}</p> : null}
  </fieldset>;
}
