import { requireAdminSession } from "@/lib/admin-auth";
import Sidebar from "@/components/admin/sidebar";
import Header from "@/components/admin/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdminSession();

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <Header userName={admin.name} />
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
