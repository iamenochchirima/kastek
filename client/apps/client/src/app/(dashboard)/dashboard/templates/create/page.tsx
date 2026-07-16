import { redirect } from "next/navigation";

export default function DashboardTemplatesCreatePage() {
  redirect("/templates?create=1");
}
