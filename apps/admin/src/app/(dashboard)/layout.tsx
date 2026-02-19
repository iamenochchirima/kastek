import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@kasiai/database";
import Sidebar from "@/components/admin/sidebar";
import Header from "@/components/admin/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) redirect("/login");

  // Verify user exists in AdminUser table
  const admin = await prisma.adminUser.findUnique({
    where: { id: session.user.id },
    select: { name: true, role: true },
  });

  if (!admin) redirect("/login");

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
