import { redirect } from "next/navigation";

export const metadata = {
  title: "Onboarding | KasiTek",
};

export default async function OnboardingPage() {
  redirect("/dashboard");
}
