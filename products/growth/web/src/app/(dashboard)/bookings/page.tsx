import { BookingsPageClient } from "@/components/dashboard/bookings/bookings-page-client";

export function meta() { return [{ title: "Bookings | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function BookingsPage() {
  return <BookingsPageClient />;
}
