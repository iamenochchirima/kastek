import { getRustSession } from "@/lib/rust-auth";
import { fetchOnboardingStatus } from "@/lib/onboarding";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "./onboarding-wizard";

export const metadata = { title: "Set up your workspace | KasiTek" };

export default async function OnboardingPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.emailVerified) {
    redirect(`/verify-request?email=${encodeURIComponent(session.user.email)}`);
  }

  const status = await fetchOnboardingStatus().catch(() => null);
  if (!status?.needsOnboarding) redirect("/workspace");

  return <OnboardingWizard profile={status.profile} />;
}
