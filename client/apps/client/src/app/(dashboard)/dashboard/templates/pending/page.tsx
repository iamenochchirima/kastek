import { redirect } from "next/navigation";

export default function DashboardTemplatesPendingPage() {
  redirect("/templates?status=PENDING");
}
