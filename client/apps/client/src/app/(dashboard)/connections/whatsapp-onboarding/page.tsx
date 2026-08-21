import WhatsappOnboardingResultCard from "@/components/dashboard/settings/whatsapp-onboarding-result-card";

export const metadata = {
  title: "WhatsApp Onboarding | KasiTek",
};

export default function ConnectionsWhatsappOnboardingResultPage() {
  return (
    <div className="min-h-[calc(100dvh-4rem)] px-4 py-8 sm:px-6 lg:flex lg:items-center lg:px-8 lg:py-16">
      <WhatsappOnboardingResultCard />
    </div>
  );
}
