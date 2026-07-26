import WhatsappOnboardingResultCard from "@/components/dashboard/settings/whatsapp-onboarding-result-card";

export const metadata = {
  title: "WhatsApp Onboarding | KasiTek",
};

export default function ConnectionsWhatsappOnboardingResultPage() {
  return (
    <div className="min-h-[calc(100vh-5rem)] px-6 py-10 lg:flex lg:items-center lg:px-8 lg:py-16">
      <WhatsappOnboardingResultCard />
    </div>
  );
}
