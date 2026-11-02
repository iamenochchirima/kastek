import { getCoreSession } from "@/lib/core-auth";
import { fetchOnboardingStatus } from "@/lib/onboarding";
import { redirect, Link, useLoaderData } from "react-router";
import { fetchOrgs } from "@/lib/orgs";
import { CreateOrgForm } from "../(dashboard)/workspace/team/new/create-org-form";
import { SessionActivity } from "@/components/auth/session-activity";
import { OnboardingWizard } from "./onboarding-wizard";

export function meta() { return [{ title: "Set up your workspace | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  const session = await getCoreSession(request);
  if (!session?.user?.id) throw redirect("/login");

  const orgs = await fetchOrgs(request);
  if (!orgs.length) return { needsOrganisation: true as const, profile: null };
  const status = await fetchOnboardingStatus();
  if (!status?.needsOnboarding) throw redirect("/workspace");

  return { needsOrganisation: false as const, profile: status.profile };
}

export default function OnboardingPage() {
  const { needsOrganisation, profile } = useLoaderData<typeof clientLoader>();
  if (needsOrganisation) {
    return (
      <main className="mx-auto min-h-[100dvh] max-w-lg space-y-6 px-4 py-12 sm:px-6">
        <SessionActivity />
        <h1 className="text-2xl font-semibold">Create organisation</h1>
        <CreateOrgForm nextPath="/onboarding" initial />
        <p className="text-center text-sm text-muted-foreground"><Link to="/invite" className="text-primary hover:underline">Have an invitation?</Link></p>
      </main>
    );
  }
  return <><SessionActivity /><OnboardingWizard profile={profile!} /></>;
}
