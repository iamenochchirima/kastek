import { redirect } from "next/navigation";

export const metadata = { title: "Dashboard | KasiTek Labs" };

export default function DashboardPage() {
  redirect("/analytics");
}
