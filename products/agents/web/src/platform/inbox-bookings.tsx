import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiError, message, type BookingConfirmation } from "./api";
import { ErrorMessage, Loading } from "./shell";

const labels = { pending: "Awaiting customer confirmation", approved: "Confirmed by customer", rejected: "Declined by customer", claimed: "Booking appointment", confirmed: "Appointment booked", conflict: "Time no longer available", uncertain: "Booking outcome unknown", expired: "Confirmation expired" };
function appointmentTime(booking: BookingConfirmation) {
  try { const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: booking.timeZone }); return `${format.format(new Date(booking.start))} to ${format.format(new Date(booking.end))} · ${booking.timeZone}`; } catch { return `${booking.start} to ${booking.end} · ${booking.timeZone}`; }
}
export function InboxBookings({ path, refreshKey }: { path: string; refreshKey: string }) {
  const [bookings, setBookings] = useState<BookingConfirmation[] | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(""), [attempt, setAttempt] = useState(0);
  const [checkErrors, setCheckErrors] = useState<Record<string, { state: string; message: string }>>({});
  const mounted = useRef(true), lock = useRef(false), statuses = useRef(new Map<string, HTMLParagraphElement>());
  const focusAfterCheck = useRef<{ id: string; trigger: HTMLButtonElement } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    api<{ bookings: BookingConfirmation[] }>(path).then(result => { if (live) { setBookings(result.bookings); setError(""); } }).catch(e => { if (live) { setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setBookings([]); } });
    return () => { live = false; };
  }, [path, refreshKey, attempt]);
  useEffect(() => {
    if (busy || !focusAfterCheck.current) return;
    const { id, trigger } = focusAfterCheck.current; focusAfterCheck.current = null;
    if (document.activeElement === trigger || document.activeElement === document.body) {
      if (trigger.isConnected) trigger.focus(); else statuses.current.get(id)?.focus();
    }
  }, [busy, bookings]);
  async function checkStatus(booking: BookingConfirmation, trigger: HTMLButtonElement) {
    if (lock.current || !["claimed", "uncertain"].includes(booking.state)) return;
    lock.current = true; setBusy(booking.id); setCheckErrors(current => ({ ...current, [booking.id]: { state: booking.state, message: "" } }));
    if (document.activeElement === trigger) focusAfterCheck.current = { id: booking.id, trigger };
    try {
      const result = await api<{ booking: BookingConfirmation }>(`${path}/${encodeURIComponent(booking.id)}/reconcile`, {});
      if (!mounted.current) return;
      if (result.booking.id !== booking.id || result.booking.taskId !== booking.taskId) throw new Error("The appointment status could not be verified.");
      setBookings(current => current?.map(item => item.id === booking.id ? result.booking : item) ?? null);
    } catch (e) { if (mounted.current) { setCheckErrors(current => ({ ...current, [booking.id]: { state: booking.state, message: message(e) } })); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setBookings([]); setError(message(e)); } } }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  if (bookings?.length === 0 && !error) return null;
  return <section className="my-4 space-y-3" aria-label="Staff appointments"><h3 className="text-sm font-medium">Appointments</h3><ErrorMessage value={error} />{!bookings && !error ? <Loading /> : bookings?.map(booking => <article className="space-y-2 rounded-md border border-border p-3" key={booking.id}><h4 className="break-words text-sm font-medium">{booking.title}</h4><p className="break-words text-sm">{appointmentTime(booking)}</p><p role="status" tabIndex={-1} ref={element => { if (element) statuses.current.set(booking.id, element); else statuses.current.delete(booking.id); }} className="text-sm text-muted-foreground">{booking.state === "pending" && Date.parse(booking.expiresAt) <= Date.now() ? labels.expired : labels[booking.state]}</p>{["claimed", "uncertain"].includes(booking.state) ? <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={event => void checkStatus(booking, event.currentTarget)}>{busy === booking.id ? "Checking…" : "Check status"}</Button> : null}<ErrorMessage value={checkErrors[booking.id]?.state === booking.state ? checkErrors[booking.id].message : ""} /></article>)}{error ? <Button type="button" size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Refresh appointments</Button> : null}</section>;
}
