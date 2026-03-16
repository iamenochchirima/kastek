import { redirect } from "next/navigation";

export default function DashboardTemplatesCreatePage() {
  redirect("/dashboard/templates?create=1");
}
