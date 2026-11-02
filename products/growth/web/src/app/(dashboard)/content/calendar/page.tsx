import { CalendarView } from "@/components/social/calendar-view";

export function meta() { return [{ title: "Content calendar | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function ContentCalendarPage() {
  return <CalendarView />;
}
