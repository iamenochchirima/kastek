import { redirect } from "next/navigation";

export default function DashboardTemplatesApprovedPage() {
  redirect("/templates?status=APPROVED");
}
