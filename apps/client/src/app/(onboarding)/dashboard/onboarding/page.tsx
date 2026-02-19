import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import OnboardingForm from "@/components/dashboard/onboarding-form";

export const metadata = {
  title: "Onboarding | KasiAI",
};

export default async function OnboardingPage() {
  const session = await auth();

  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { phone: true },
  });

  if (user?.phone) redirect("/dashboard");

  return (
    <div>
      <h1 className="mb-2 font-serif text-3xl">
        Welcome to Kasi<span className="text-accent">AI</span>
      </h1>
      <p className="mb-8 text-text-muted">
        Before we get started, we need your phone number so we can reach you.
      </p>
      <OnboardingForm />
    </div>
  );
}
