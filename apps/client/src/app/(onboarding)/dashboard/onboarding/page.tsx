import { redirect } from "next/navigation";

export const metadata = {
  title: "Onboarding | KasiAI",
};

export default async function OnboardingPage() {
  redirect("/dashboard");
}
