import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import BotStatusBadge from "@/components/dashboard/bots/bot-status-badge";

const typeLabels: Record<string, string> = {
  starter: "Starter — Menu-driven",
  growth: "Growth — AI-powered",
};

const languageLabels: Record<string, string> = {
  en: "English",
  zu: "isiZulu",
  af: "Afrikaans",
  st: "Sesotho",
  xh: "isiXhosa",
  tn: "Setswana",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bot = await prisma.botConfiguration.findUnique({ where: { id } });
  return { title: bot ? `${bot.name} | KasiTek` : "Bot | KasiTek" };
}

export default async function BotDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

  const bot = await prisma.botConfiguration.findFirst({
    where: { id, userId: session.user.id },
  });

  if (!bot) notFound();

  const details = (bot.knowledgeBase as Record<string, string> | null) || {};

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/dashboard/bots"
        className="mb-6 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
      >
        ← Back to My Bots
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">{bot.name}</h1>
          <p className="text-sm text-text-muted">
            {typeLabels[bot.type] || bot.type}
          </p>
        </div>
        <BotStatusBadge status={bot.status} />
      </div>

      <div className="space-y-6">
        <Section title="Configuration">
          <Row label="Language" value={languageLabels[bot.language] || bot.language} />
          <Row label="Status" value={bot.status} />
          <Row
            label="Created"
            value={bot.createdAt.toLocaleDateString("en-ZA", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          />
        </Section>

        {Object.keys(details).length > 0 && (
          <Section title="Business Details">
            {details.businessType && (
              <Row label="Business type" value={details.businessType} />
            )}
            {details.description && (
              <Row label="Description" value={details.description} />
            )}
            {details.services && (
              <Row label="Services" value={details.services} />
            )}
            {details.operatingHours && (
              <Row label="Hours" value={details.operatingHours} />
            )}
            {details.whatsappNumber && (
              <Row label="WhatsApp" value={details.whatsappNumber} />
            )}
          </Section>
        )}

        <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
          <p className="text-sm font-medium text-accent">Next steps</p>
          <p className="mt-1 text-sm text-text-muted">
            {bot.type === "starter"
              ? "Your menu-driven bot is ready for configuration. You'll soon be able to set up conversation flows, quick replies, and menu options."
              : "Your AI bot is being prepared. Soon you'll be able to fine-tune responses and test conversations before going live."}
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold text-text">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <span className="w-32 shrink-0 text-sm text-text-dim">{label}</span>
      <span className="text-sm text-text whitespace-pre-line">{value}</span>
    </div>
  );
}
