import { auth } from "@/auth";
import { LayoutShell } from "@/components/dashboard2/layout-shell";
import { prisma } from "@/lib/prisma";
import ThemeScope from "@/components/theme-scope";
import { redirect } from "next/navigation";

export default async function Dashboard2Layout({ children }: { children: React.ReactNode }) {
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
      <LayoutShell user={session.user} inboxUnreadCount={unreadInboxCount}>
        {children}
      </LayoutShell>
    </>
  );
}
