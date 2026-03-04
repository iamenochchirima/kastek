import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Sidebar from "@/components/dashboard/sidebar";
import DashboardHeader from "@/components/dashboard/header";
import ThemeScope from "@/components/theme-scope";
import InboxAlertRuntime from "@/components/dashboard/inbox/inbox-alert-runtime";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) redirect("/login");

  return (
    <>
      <ThemeScope mode="stored" />
      <InboxAlertRuntime />
      <div className="flex min-h-screen bg-bg">
        <Sidebar user={session.user} />
        <div className="flex flex-1 flex-col">
          <DashboardHeader />
          <main className="flex-1 p-8 max-sm:p-4">{children}</main>
        </div>
      </div>
    </>
  );
}
