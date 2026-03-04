import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Sidebar from "@/components/dashboard/sidebar";
import ThemeScope from "@/components/theme-scope";
import InboxAlertRuntime from "@/components/dashboard/inbox/inbox-alert-runtime";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) redirect("/login");

  const connections = await prisma.whatsappConnection.findMany({
    where: { userId: session.user.id },
    select: { id: true },
  });

  const unreadInboxCount =
    connections.length === 0
      ? 0
      : (
          await prisma.conversation.aggregate({
            where: {
              channel: "whatsapp",
              OR: connections.map((connection) => ({
                customerIdentifier: {
                  startsWith: `wa:${connection.id}:`,
                },
              })),
            },
            _sum: {
              unreadCount: true,
            },
          })
        )._sum.unreadCount || 0;

  return (
    <>
      <ThemeScope mode="stored" />
      <InboxAlertRuntime />
      <div className="flex min-h-screen bg-bg">
        <Sidebar user={session.user} inboxUnreadCount={unreadInboxCount} />
        <div className="flex flex-1 flex-col">
          <main className="flex-1 p-8 max-sm:p-4">{children}</main>
        </div>
      </div>
    </>
  );
}
