import { getCoreSession } from "@/lib/core-auth";
import { fetchOnboardingStatus } from "@/lib/onboarding";
import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchOrgs } from "@/lib/orgs";
import { CreateOrgForm } from "../(dashboard)/workspace/team/new/create-org-form";
import { SessionActivity } from "@/components/auth/session-activity";
import { OnboardingWizard } from "./onboarding-wizard";

export const metadata = { title: "Set up your workspace | KasiTek" };

export default async function OnboardingPage() {
  const session = await getCoreSession();
  if (!session?.user?.id) redirect("/login");

  const orgs = await fetchOrgs();
  if (!orgs.length) {
    return (
      <main className="mx-auto min-h-[100dvh] max-w-lg space-y-6 px-4 py-12 sm:px-6">
        <SessionActivity />
        <h1 className="text-2xl font-semibold">Create organisation</h1>
        <CreateOrgForm nextPath="/onboarding" initial />
        <p className="text-center text-sm text-muted-foreground"><Link href="/invite" className="text-primary hover:underline">Have an invitation?</Link></p>
      </main>
    );
  }
  const status = await fetchOnboardingStatus().catch(() => null);
  if (!status?.needsOnboarding) redirect("/workspace");

  return <><SessionActivity /><OnboardingWizard profile={status.profile} /></>;
}
