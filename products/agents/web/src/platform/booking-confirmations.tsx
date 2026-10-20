import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, message, organizationPath, type BookingConfirmation } from "./api";
import { ErrorMessage, useWorkspace } from "./shell";

type Booking = BookingConfirmation;
function bookingTime(booking: Booking) {
  try { const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: booking.timeZone }); return `${format.format(new Date(booking.start))} to ${format.format(new Date(booking.end))} · ${booking.timeZone}`; } catch { return `${booking.start} to ${booking.end} · ${booking.timeZone}`; }
}
const labels = { pending: "Confirm appointment", approved: "Confirmed by you", rejected: "Declined", claimed: "Booking appointment", confirmed: "Appointment booked", conflict: "Time no longer available", uncertain: "Booking outcome unknown", expired: "Confirmation expired" };
export function BookingConfirmations({ taskId, awaiting, available, onRefresh }: { taskId: string; awaiting: boolean; available: boolean; onRefresh?: () => void }) {
  const { organizationId } = useWorkspace(), { confirm } = useConfirmationDialog();
  const path = `${organizationPath(organizationId)}/tasks/${encodeURIComponent(taskId)}/bookings`;
  const [bookings, setBookings] = useState<Booking[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(""), [refresh, setRefresh] = useState(0);
  const latest = useRef(bookings); latest.current = bookings;
  const mounted = useRef(true), lock = useRef(false), parentRefresh = useRef(onRefresh); parentRefresh.current = onRefresh;
  const statusElements = useRef(new Map<string, HTMLParagraphElement>());
  const focusAfterCheck = useRef<{ id: string; trigger: HTMLButtonElement } | null>(null);
  const [checkErrors, setCheckErrors] = useState<Record<string, { state: string; message: string }>>({});
  const [blocked, setBlocked] = useState<string[]>([]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!awaiting && !available && !latest.current.length) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>, uncertainPolls = 0;
    async function poll() {
      try {
        const result = await api<{ bookings: Booking[] }>(path); if (cancelled) return;
        const scoped = result.bookings.filter(booking => booking.taskId === taskId); setBookings(scoped);
        const unresolved = scoped.some(booking => ["pending", "approved", "claimed"].includes(booking.state) && (booking.state !== "pending" || Date.parse(booking.expiresAt) > Date.now()));
        if (!unresolved && scoped.some(booking => booking.state === "uncertain") && ++uncertainPolls >= 3) return;
        if (!unresolved && !awaiting) return;
        timer = setTimeout(() => void poll(), 1200);
      } catch (e) { if (cancelled) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setBookings([]); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [path, taskId, awaiting, available, refresh]);
  useEffect(() => {
    if (busy || !focusAfterCheck.current) return;
    const { id, trigger } = focusAfterCheck.current; focusAfterCheck.current = null;
    if (document.activeElement === trigger || document.activeElement === document.body) {
      if (trigger.isConnected) trigger.focus(); else statusElements.current.get(id)?.focus();
    }
  }, [busy, bookings]);
  async function checkStatus(booking: Booking, trigger: HTMLButtonElement) {
    if (lock.current || !["claimed", "uncertain"].includes(booking.state)) return;
    lock.current = true; setBusy(booking.id); setError(""); setCheckErrors(current => ({ ...current, [booking.id]: { state: booking.state, message: "" } }));
    if (document.activeElement === trigger) focusAfterCheck.current = { id: booking.id, trigger };
    try {
      const result = await api<{ booking: Booking }>(`${path}/${encodeURIComponent(booking.id)}/reconcile`, {});
      if (!mounted.current) return;
      if (result.booking.taskId !== taskId) throw new Error("The appointment status could not be verified.");
      setBookings(current => current.map(item => item.id === result.booking.id ? result.booking : item)); parentRefresh.current?.();
    } catch (e) { if (mounted.current) { setCheckErrors(current => ({ ...current, [booking.id]: { state: booking.state, message: message(e) } })); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setBookings([]); setError(message(e)); } } }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function decide(booking: Booking, decision: "approve" | "reject") {
    if (lock.current || booking.state !== "pending" || Date.parse(booking.expiresAt) <= Date.now() || blocked.includes(booking.requestDigest)) return;
    lock.current = true;
    if (decision === "approve" && !await confirm({ title: "Confirm this appointment?", description: `${booking.title} · ${bookingTime(booking)}`, confirmLabel: "Confirm appointment" })) { lock.current = false; return; }
    if (!mounted.current || Date.parse(booking.expiresAt) <= Date.now() || !latest.current.some(current => current.id === booking.id && current.requestDigest === booking.requestDigest && current.state === "pending")) { lock.current = false; return; }
    setBusy(booking.id); setError("");
    try { const result = await api<{ booking: Booking }>(`${path}/${encodeURIComponent(booking.id)}/decision`, { decision, requestDigest: booking.requestDigest }); if (!mounted.current) return; setBookings(current => current.map(item => item.id === result.booking.id ? result.booking : item)); setRefresh(value => value + 1); parentRefresh.current?.(); }
    catch (e) { if (!mounted.current) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setBookings([]); if (e instanceof ApiError && e.status === 409) { setBlocked(current => [...current, booking.requestDigest]); setRefresh(value => value + 1); } }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  if (!bookings.length && !error) return null;
  return <section aria-label="Appointments" className="space-y-3"><ErrorMessage value={error} />{bookings.map(booking => {
    const expired = booking.state === "pending" && Date.parse(booking.expiresAt) <= Date.now();
    return <article key={booking.id} className="space-y-2 rounded-md border border-border p-4"><h3 className="font-medium break-words">{booking.title}</h3><p className="text-sm break-words">{bookingTime(booking)}</p><p ref={element => { if (element) statusElements.current.set(booking.id, element); else statusElements.current.delete(booking.id); }} tabIndex={-1} role="status" className="text-sm text-muted-foreground">{expired ? labels.expired : labels[booking.state]}</p>{booking.state === "uncertain" ? <p className="text-sm text-muted-foreground">Check with the organization before booking again.</p> : booking.state === "conflict" ? <p className="text-sm text-muted-foreground">Ask for another available time.</p> : null}{booking.state === "pending" && !expired && !blocked.includes(booking.requestDigest) ? <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void decide(booking, "approve")}>Confirm appointment</Button><Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void decide(booking, "reject")}>Decline</Button></div> : null}{["claimed", "uncertain"].includes(booking.state) ? <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={event => void checkStatus(booking, event.currentTarget)}>{busy === booking.id ? "Checking…" : "Check status"}</Button> : null}<ErrorMessage value={checkErrors[booking.id]?.state === booking.state ? checkErrors[booking.id].message : ""} /></article>;
  })}{error && !bookings.length ? <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => setRefresh(value => value + 1)}>Refresh appointment</Button> : null}</section>;
}
