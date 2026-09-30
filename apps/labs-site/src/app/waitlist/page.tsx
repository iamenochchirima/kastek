import type { Metadata } from "next";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { EarlyAccessForm } from "@/components/early-access-form";

export const metadata: Metadata = {
  title: "Early Access | Kasitek",
  description: "Apply to test the KasiTek workspace with your team.",
};

export default function WaitlistPage() {
  return (
    <LabsInnerShell>
      <section className="enquiry-page early-access-page">
        <EarlyAccessForm />
      </section>
    </LabsInnerShell>
  );
}
