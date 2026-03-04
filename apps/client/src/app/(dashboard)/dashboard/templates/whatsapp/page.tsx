import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import WhatsappTemplateManager from "@/components/dashboard/campaigns/whatsapp-template-manager";

export const metadata = {
  title: "Your Templates | KasiTek",
};

export default async function WhatsappTemplatesManagementPage({
  searchParams,
}: {
  searchParams: Promise<{ starter?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;

  const [templates, connections] = await Promise.all([
    prisma.whatsappTemplate.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        connection: {
          select: {
            phoneDisplayNumber: true,
            phoneNumberId: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.whatsappConnection.findMany({
      where: {
        userId: session.user.id,
      },
      select: {
        id: true,
        phoneDisplayNumber: true,
        phoneNumberId: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/dashboard/templates"
            className="mb-2 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
          >
            ← Back to Templates
          </Link>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">Your Templates</h1>
          <p className="text-text-muted">
            Create, sync, and manage the WhatsApp templates attached to your account.
          </p>
        </div>
      </div>

      {connections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface p-8 text-sm text-text-muted">
          Connect a WhatsApp number first under WhatsApp Campaigns before managing templates.
        </div>
      ) : (
        <WhatsappTemplateManager
          connections={connections}
          initialLibraryItemId={params.starter}
          templates={templates.map((template) => ({
            id: template.id,
            templateName: template.templateName,
            language: template.language,
            category: template.category,
            status: template.status,
            variablesCount: template.variablesCount,
            body: template.body,
            lastSynced: template.lastSynced ? template.lastSynced.toISOString() : null,
            connectionLabel:
              template.connection?.phoneDisplayNumber || template.connection?.phoneNumberId || "-",
          }))}
        />
      )}
    </div>
  );
}
