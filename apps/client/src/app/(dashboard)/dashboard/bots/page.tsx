import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import BotCard from "@/components/dashboard/bots/bot-card";
import EmptyState from "@/components/dashboard/bots/empty-state";

export const metadata = {
  title: "My Bots | KasiTek",
};

export default async function BotsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const bots = await prisma.botConfiguration.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">My Bots</h1>
          <p className="text-text-muted">
            Create and manage your WhatsApp chatbots.
          </p>
        </div>
        {bots.length > 0 && (
          <Link
            href="/dashboard/bots/new"
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
          >
            New Bot
          </Link>
        )}
      </div>

      {bots.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <BotCard
              key={bot.id}
              id={bot.id}
              name={bot.name}
              type={bot.type}
              status={bot.status}
              createdAt={bot.createdAt}
            />
          ))}
        </div>
      )}
    </div>
  );
}
