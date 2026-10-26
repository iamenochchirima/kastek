import { BookingPolicies, type BookingPoliciesProps } from "./booking-policies";

export type GuidedBookingSetupProps = Pick<BookingPoliciesProps,
  "agentId" | "configuration" | "onChange" | "initialDurationMinutes" | "returnTo" | "onBusyChange" | "onBeforeConnect"
>;

export function GuidedBookingSetup(props: GuidedBookingSetupProps) {
  return <div className="space-y-4">
    <h2 className="text-xl font-semibold">Appointments</h2>
    <BookingPolicies {...props} embedded autoSelectCreated />
    <p className="text-xs text-muted-foreground">Customers confirm the appointment before it is booked.</p>
  </div>;
}
