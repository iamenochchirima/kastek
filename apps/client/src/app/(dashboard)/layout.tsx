import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import Sidebar from "@/components/dashboard/sidebar";
import DashboardHeader from "@/components/dashboard/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) redirect("/login");

  // Redirect to onboarding if phone number is missing
  if (session.user.id) {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { phone: true },
    });

    if (!user?.phone) redirect("/dashboard/onboarding");
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <DashboardHeader user={session.user} />
        <main className="flex-1 p-8 max-sm:p-4">{children}</main>
      </div>
    </div>
  );
}
