import { redirect } from "next/navigation";

export default function DashboardTemplatesApprovedPage() {
  redirect("/dashboard/templates?status=APPROVED");
}
