import type { Metadata } from "next";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { EarlyAccessForm } from "@/components/early-access-form";

export const metadata: Metadata = {
  title: "Early Access | Kasitek",
  description: "Apply for early access to the KasiTek beta workspace.",
};

export default function WaitlistPage() {
  return (
    <LabsInnerShell>
      <section className="enquiry-page early-access-page">
        <div className="enquiry-intro">
          <p>Beta programme</p>
          <h1>Put the workspace to work.</h1>
          <p>Tell us where your business needs a better operating layer. We&apos;ll review each application.</p>
          <ol className="quote-process">
            <li><span>01</span><p>Share the operation you want to improve.</p></li>
            <li><span>02</span><p>We review fit, timing and access.</p></li>
            <li><span>03</span><p>Approved teams receive an invitation.</p></li>
          </ol>
        </div>
        <EarlyAccessForm />
      </section>
    </LabsInnerShell>
  );
}
