import CampaignCreateForm from "@/components/dashboard/campaigns/campaign-create-form";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "next/navigation";
import { MotionReveal } from "@/components/ui/motion-reveal";

export const metadata = {
  title: "Create Campaign | KasiTek",
};

export default async function ReachCampaignsCreatePage() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");

  const [connectionResponse, templateResponse, contactResponse] = await Promise.all([
    fetchCoreJson<{
      connections: Array<{
        id: string;
        phoneDisplayNumber: string | null;
        phoneNumberId: string;
      }>;
    }>("/api/whatsapp/connections"),
    fetchCoreJson<{
      templates: Array<{
        id: string;
        templateName: string;
        language: string;
        category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
        status: "APPROVED" | "PENDING" | "REJECTED" | "DISABLED";
        variablesCount: number;
        body: string | null;
        connectionId?: string | null;
        connectionLabel: string;
      }>;
    }>("/api/whatsapp/templates?status=APPROVED"),
    fetchCoreJson<{
      contacts: Array<{
        id: string;
        fullName?: string | null;
        phone: string;
        tags: string[];
        location?: string | null;
        listLabel: string;
        metadata: Record<string, string> | null;
        excluded?: boolean;
        optIn?: boolean;
      }>;
      lists: Array<{
        label: string;
        totalContacts: number;
        primaryLocation: string | null;
        metadataKeys: string[];
      }>;
    }>("/api/whatsapp/contacts"),
  ]);

  return (
    <MotionReveal className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1200px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Create campaign</h1>
          <p className="mt-1 text-muted-foreground">Configure your WhatsApp campaign.</p>
        </div>

        <CampaignCreateForm
          connections={connectionResponse.connections}
          templates={templateResponse.templates}
          contacts={contactResponse.contacts}
          lists={contactResponse.lists}
        />
      </div>
    </MotionReveal>
  );
}
