import type { Metadata } from "next";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { EarlyAccessForm } from "@/components/early-access-form";

export const metadata: Metadata = {
  title: "Early Access | Kasitek",
  description: "Request early access to KasiTek Growth, Agency, Agents, or the full product suite.",
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
