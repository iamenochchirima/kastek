import { auth } from "@/auth";
import WhatsappTemplateManager from "@/components/dashboard/campaigns/whatsapp-template-manager";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Templates | KasiTek",
};

export default async function DashboardTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ starter?: string; status?: string; create?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const requestedStatus = typeof params.status === "string" ? params.status.toUpperCase() : "";
  const allowedStatuses = new Set(["APPROVED", "PENDING", "REJECTED", "DISABLED"]);

  const [templates, connections] = await Promise.all([
    prisma.whatsappTemplate.findMany({
      where: {
        userId: session.user.id,
        ...(allowedStatuses.has(requestedStatus)
          ? { status: requestedStatus as "APPROVED" | "PENDING" | "REJECTED" | "DISABLED" }
          : {}),
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
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Templates</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Create, submit, sync, and manage the WhatsApp templates attached to your account.
          </p>
        </div>

        {connections.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card p-8 text-sm text-muted-foreground">
            Connect a WhatsApp number first before managing templates.
          </div>
        ) : (
          <WhatsappTemplateManager
            connections={connections}
            forceCreateForm={params.create === "1"}
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
    </div>
  );
}
