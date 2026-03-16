import { redirect } from "next/navigation";

export default function DashboardTemplatesPendingPage() {
  redirect("/dashboard/templates?status=PENDING");
}
