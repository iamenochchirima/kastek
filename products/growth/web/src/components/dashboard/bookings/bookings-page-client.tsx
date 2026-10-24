import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, Check, Clock3, Plus, RefreshCw } from "lucide-react";
import { apiUrl } from "@/lib/server-api";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type BookingService = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  active: boolean;
};

type Booking = {
  id: string;
  serviceId: string;
  serviceName: string;
  customerId: string | null;
  customerName: string | null;
  contactName: string;
  contactPhone: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  timezone: string;
  status: "SCHEDULED" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  notes: string | null;
};

type ContactOption = {
  id: string;
  customerId: string | null;
  phone: string;
  fullName: string | null;
};

type BookingDraft = {
  serviceId: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  scheduledStart: string;
  notes: string;
};

const emptyService = { name: "", description: "", durationMinutes: "30" };

function defaultStartInput() {
  const start = new Date();
  start.setMinutes(Math.ceil((start.getMinutes() + 5) / 15) * 15, 0, 0);
  start.setHours(start.getHours() + 1);
  const offset = start.getTimezoneOffset() * 60_000;
  return new Date(start.getTime() - offset).toISOString().slice(0, 16);
}

function emptyBookingDraft(serviceId = ""): BookingDraft {
  return { serviceId, contactId: "", contactName: "", contactPhone: "", scheduledStart: defaultStartInput(), notes: "" };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(minutes: number) {
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes} min`;
}

function statusMeta(status: Booking["status"]) {
  if (status === "CONFIRMED") return { label: "Confirmed", className: "bg-status-success-soft text-status-success" };
  if (status === "COMPLETED") return { label: "Completed", className: "bg-secondary text-foreground" };
  if (status === "CANCELLED") return { label: "Cancelled", className: "bg-status-danger-soft text-destructive" };
  if (status === "NO_SHOW") return { label: "No show", className: "bg-status-attention-soft text-status-attention" };
  return { label: "Scheduled", className: "bg-status-info-soft text-status-info" };
}

export function BookingsPageClient() {
  const [services, setServices] = useState<BookingService[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showServiceForm, setShowServiceForm] = useState(false);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [serviceForm, setServiceForm] = useState(emptyService);
  const [bookingForm, setBookingForm] = useState<BookingDraft>(emptyBookingDraft());

  const activeServices = useMemo(() => services.filter((service) => service.active), [services]);
  const upcomingBookings = useMemo(
    () => bookings.filter((booking) => !["COMPLETED", "CANCELLED", "NO_SHOW"].includes(booking.status)),
    [bookings],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [servicesResponse, bookingsResponse, contactsResponse] = await Promise.all([
        fetch(apiUrl("/api/bookings/services"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/bookings"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/whatsapp/contacts"), { credentials: "include", cache: "no-store" }),
      ]);
      const servicesPayload = (await servicesResponse.json()) as { services?: BookingService[]; error?: string };
      const bookingsPayload = (await bookingsResponse.json()) as { bookings?: Booking[]; error?: string };
      const contactsPayload = (await contactsResponse.json()) as { contacts?: ContactOption[]; error?: string };
      if (!servicesResponse.ok) throw new Error(servicesPayload.error || "Failed to load booking services");
      if (!bookingsResponse.ok) throw new Error(bookingsPayload.error || "Failed to load bookings");
      setServices(servicesPayload.services || []);
      setBookings(bookingsPayload.bookings || []);
      setContacts(contactsPayload.contacts || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load bookings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createService(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/bookings/services"), {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: serviceForm.name, description: serviceForm.description, durationMinutes: Number(serviceForm.durationMinutes) }),
      });
      const payload = (await response.json()) as { service?: BookingService; error?: string };
      if (!response.ok || !payload.service) throw new Error(payload.error || "Failed to create service");
      setServices((current) => [...current, payload.service!].sort((a, b) => a.name.localeCompare(b.name)));
      setBookingForm((current) => ({ ...current, serviceId: current.serviceId || payload.service!.id }));
      setServiceForm(emptyService);
      setShowServiceForm(false);
      toast.success("Service created");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create service");
    } finally { setSaving(false); }
  }

  function chooseContact(contactId: string) {
    const contact = contacts.find((candidate) => candidate.id === contactId);
    setBookingForm((current) => ({
      ...current,
      contactId,
      contactName: contact?.fullName || current.contactName,
      contactPhone: contact?.phone || current.contactPhone,
    }));
  }

  async function createBooking(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const selectedContact = contacts.find((contact) => contact.id === bookingForm.contactId);
      const response = await fetch(apiUrl("/api/bookings"), {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceId: bookingForm.serviceId,
          customerId: selectedContact?.customerId || undefined,
          contactName: bookingForm.contactName,
          contactPhone: bookingForm.contactPhone,
          scheduledStart: new Date(bookingForm.scheduledStart).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Johannesburg",
          notes: bookingForm.notes,
        }),
      });
      const payload = (await response.json()) as { booking?: Booking; error?: string };
      if (!response.ok || !payload.booking) throw new Error(payload.error || "Failed to create booking");
      setBookings((current) => [...current, payload.booking!].sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart)));
      setBookingForm(emptyBookingDraft(activeServices[0]?.id || ""));
      setShowBookingForm(false);
      toast.success("Booking scheduled");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create booking");
    } finally { setSaving(false); }
  }

  async function setStatus(booking: Booking, status: Booking["status"]) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/bookings/${booking.id}`), {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = (await response.json()) as { booking?: Booking; error?: string };
      if (!response.ok || !payload.booking) throw new Error(payload.error || "Failed to update booking");
      setBookings((current) => current.map((item) => item.id === booking.id ? payload.booking! : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update booking");
    } finally { setSaving(false); }
  }

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Bookings</PageHeaderTitle>
            <PageHeaderDescription>Appointments and services.</PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="h-4 w-4" /> Refresh</Button>
            <Button variant="outline" size="sm" onClick={() => setShowServiceForm(true)}><Plus className="h-4 w-4" /> Add service</Button>
            <Button size="sm" onClick={() => { setBookingForm(emptyBookingDraft(activeServices[0]?.id || "")); setShowBookingForm(true); }} disabled={!activeServices.length}><CalendarCheck className="h-4 w-4" /> New booking</Button>
          </PageHeaderActions>
        </PageHeader>

        {error ? <div className="rounded-lg border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">{error}</div> : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Upcoming", upcomingBookings.length, "Appointments still needing an outcome"],
            ["Confirmed", bookings.filter((booking) => booking.status === "CONFIRMED").length, "Ready to deliver"],
            ["Completed", bookings.filter((booking) => booking.status === "COMPLETED").length, "Recorded service outcomes"],
            ["No shows", bookings.filter((booking) => booking.status === "NO_SHOW").length, "Contacts to re-engage"],
          ].map(([label, value, helper], index) => <MotionReveal key={String(label)} delay={0.08 + index * 0.06} hoverLift className="h-full"><Card className="h-full"><CardContent className="p-5"><p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-semibold text-foreground">{loading ? "–" : value}</p><p className="mt-2 text-sm text-muted-foreground">{helper}</p></CardContent></Card></MotionReveal>)}
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card>
            <CardHeader><CardTitle>Appointment schedule</CardTitle><CardDescription>Each booking is linked to a service and, where available, a Contact record.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              {loading ? <p className="text-sm text-muted-foreground">Loading bookings…</p> : bookings.length ? bookings.map((booking) => {
                const status = statusMeta(booking.status);
                return <div key={booking.id} className="flex flex-col gap-4 rounded-lg border border-border p-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-foreground">{booking.contactName}</p><Badge className={`border-0 ${status.className}`}>{status.label}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{booking.serviceName} · {formatDate(booking.scheduledStart)} · {booking.timezone}</p>{booking.contactPhone ? <p className="mt-1 text-xs text-muted-foreground">{booking.contactPhone}</p> : null}{booking.notes ? <p className="mt-2 text-sm text-muted-foreground">{booking.notes}</p> : null}</div><div className="flex flex-wrap gap-2">{booking.status === "SCHEDULED" ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void setStatus(booking, "CONFIRMED")}><Check className="h-4 w-4" /> Confirm</Button> : null}{["SCHEDULED", "CONFIRMED"].includes(booking.status) ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void setStatus(booking, "COMPLETED")}>Complete</Button> : null}{["SCHEDULED", "CONFIRMED"].includes(booking.status) ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void setStatus(booking, "NO_SHOW")}>No show</Button> : null}{["SCHEDULED", "CONFIRMED"].includes(booking.status) ? <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={saving} onClick={() => void setStatus(booking, "CANCELLED")}>Cancel</Button> : null}</div></div>;
              }) : <div className="rounded-lg border border-dashed border-border px-5 py-12 text-center"><CalendarCheck className="mx-auto h-7 w-7 text-muted-foreground" /><p className="mt-3 font-medium text-foreground">No bookings yet</p><p className="mt-1 text-sm text-muted-foreground">Create a service, then schedule the first appointment.</p></div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Services</CardTitle><CardDescription>Services determine available booking durations.</CardDescription></CardHeader>
            <CardContent className="space-y-3">{loading ? <p className="text-sm text-muted-foreground">Loading services…</p> : services.length ? services.map((service) => <div key={service.id} className="rounded-lg border border-border p-3"><div className="flex items-start justify-between gap-2"><p className="font-medium text-foreground">{service.name}</p><span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{formatDuration(service.durationMinutes)}</span></div>{service.description ? <p className="mt-1 text-sm text-muted-foreground">{service.description}</p> : null}{!service.active ? <Badge variant="outline" className="mt-2">Inactive</Badge> : null}</div>) : <p className="text-sm text-muted-foreground">Add the services clients can book.</p>}</CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showServiceForm} onOpenChange={setShowServiceForm}>
        <DialogContent className="max-w-lg">
          <form onSubmit={createService}>
            <DialogHeader>
              <DialogTitle>Add booking service</DialogTitle>
              <DialogDescription>Create a service clients can book.</DialogDescription>
            </DialogHeader>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-medium text-foreground">Service name<Input className="mt-1.5" value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} placeholder="Consultation" required /></label>
              <label className="block text-sm font-medium text-foreground">Duration (minutes)<Input className="mt-1.5" type="number" min="5" max="1440" value={serviceForm.durationMinutes} onChange={(event) => setServiceForm({ ...serviceForm, durationMinutes: event.target.value })} required /></label>
              <label className="block text-sm font-medium text-foreground">Description <span className="font-normal text-muted-foreground">(optional)</span><Textarea className="mt-1.5" value={serviceForm.description} onChange={(event) => setServiceForm({ ...serviceForm, description: event.target.value })} placeholder="What the client can expect" /></label>
            </div>
            <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => setShowServiceForm(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Creating…" : "Create service"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showBookingForm} onOpenChange={setShowBookingForm}>
        <DialogContent className="max-h-[calc(100svh-2rem)] max-w-xl overflow-y-auto">
          <form onSubmit={createBooking}>
            <DialogHeader>
              <DialogTitle>New booking</DialogTitle>
              <DialogDescription>Schedule a service and contact.</DialogDescription>
            </DialogHeader>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium text-foreground">Service<Select value={bookingForm.serviceId} onValueChange={(serviceId) => setBookingForm({ ...bookingForm, serviceId })}><SelectTrigger className="mt-1.5 w-full"><SelectValue placeholder="Choose service" /></SelectTrigger><SelectContent>{activeServices.map((service) => <SelectItem key={service.id} value={service.id}>{service.name} · {formatDuration(service.durationMinutes)}</SelectItem>)}</SelectContent></Select></label>
              <label className="block text-sm font-medium text-foreground">Start time<Input className="mt-1.5" type="datetime-local" value={bookingForm.scheduledStart} onChange={(event) => setBookingForm({ ...bookingForm, scheduledStart: event.target.value })} required /></label>
              <label className="block text-sm font-medium text-foreground sm:col-span-2">Existing Contact <span className="font-normal text-muted-foreground">(optional)</span><Select value={bookingForm.contactId || "manual"} onValueChange={(value) => chooseContact(value === "manual" ? "" : value)}><SelectTrigger className="mt-1.5 w-full"><SelectValue placeholder="Enter contact details manually" /></SelectTrigger><SelectContent><SelectItem value="manual">Enter contact details manually</SelectItem>{contacts.map((contact) => <SelectItem key={contact.id} value={contact.id}>{contact.fullName || contact.phone} · {contact.phone}</SelectItem>)}</SelectContent></Select></label>
              <label className="block text-sm font-medium text-foreground">Contact name<Input className="mt-1.5" value={bookingForm.contactName} onChange={(event) => setBookingForm({ ...bookingForm, contactName: event.target.value })} required /></label>
              <label className="block text-sm font-medium text-foreground">Phone <span className="font-normal text-muted-foreground">(optional)</span><Input className="mt-1.5" value={bookingForm.contactPhone} onChange={(event) => setBookingForm({ ...bookingForm, contactPhone: event.target.value })} /></label>
              <label className="block text-sm font-medium text-foreground sm:col-span-2">Notes <span className="font-normal text-muted-foreground">(optional)</span><Textarea className="mt-1.5" value={bookingForm.notes} onChange={(event) => setBookingForm({ ...bookingForm, notes: event.target.value })} placeholder="Context, preference, or preparation notes" /></label>
            </div>
            <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => setShowBookingForm(false)}>Cancel</Button><Button type="submit" disabled={saving || !bookingForm.serviceId}>{saving ? "Scheduling…" : "Schedule booking"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
