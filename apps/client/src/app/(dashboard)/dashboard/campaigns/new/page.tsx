import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import CreateCampaignForm from "@/components/dashboard/campaigns/create-campaign-form";

export const metadata = {
  title: "Create Campaign | KasiAI",
};

export default async function NewCampaignPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [connections, templates, contacts] = await Promise.all([
    prisma.whatsappConnection.findMany({
      where: {
        userId: session.user.id,
      },
      select: {
        id: true,
        phoneDisplayNumber: true,
        phoneNumberId: true,
        verified: true,
        currentQualityRating: true,
        dailyLimitEstimate: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.whatsappTemplate.findMany({
      where: {
        userId: session.user.id,
        category: "MARKETING",
        status: "APPROVED",
      },
      select: {
        id: true,
        templateName: true,
        language: true,
        status: true,
        variablesCount: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    }),
    prisma.whatsappContact.findMany({
      where: {
        userId: session.user.id,
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        location: true,
        optIn: true,
        excluded: true,
        lastMarketingSent: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 500,
    }),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/dashboard/campaigns"
        className="mb-5 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
      >
        ← Back to campaigns
      </Link>

      <h1 className="mb-2 font-serif text-3xl">Create campaign</h1>
      <p className="mb-8 text-text-muted">
        Build a compliant marketing broadcast with approved templates and opted-in recipients.
      </p>

      <CreateCampaignForm
        connections={connections}
        templates={templates}
        contacts={contacts.map((contact) => ({
          ...contact,
          lastMarketingSent: contact.lastMarketingSent
            ? contact.lastMarketingSent.toISOString()
            : null,
        }))}
      />
    </div>
  );
}
