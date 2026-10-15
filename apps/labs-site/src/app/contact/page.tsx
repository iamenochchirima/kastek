import type { Metadata } from "next";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { ProjectEnquiryForm } from "@/components/project-enquiry-form";

export const metadata: Metadata = {
  title: "Contact | Kasitek Labs",
  description:
    "Contact Kasitek Labs about the Kasitek platform, AI delivery, custom systems or partnership.",
};

export default function ContactPage() {
  return (
    <LabsInnerShell>
      <section className="enquiry-page">
        <div className="enquiry-intro">
          <p>Contact</p>
          <h1>Start with the work that needs attention.</h1>
          <p>
            Tell us what you are operating, building or trying to connect. We
            will come back with the most useful next step.
          </p>
        </div>
        <ProjectEnquiryForm mode="contact" />
      </section>
    </LabsInnerShell>
  );
}
