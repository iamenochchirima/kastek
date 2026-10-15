import type { Metadata } from "next";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { ProjectEnquiryForm } from "@/components/project-enquiry-form";

export const metadata: Metadata = {
  title: "Request a Quote | Kasitek Labs",
  description:
    "Request a scoped quote for the Kasitek platform, AI agents, integrations and applications. Forward-deployed delivery is coming soon.",
};

export default function GetQuotePage() {
  return (
    <LabsInnerShell>
      <section className="enquiry-page quote-page">
        <div className="enquiry-intro">
          <p>Project scope</p>
          <h1>Tell us what needs to be built.</h1>
          <p>
            Give us the operating context and the intended result. We will
            review the work before recommending a scope and price.
          </p>
          <ol className="quote-process">
            <li>
              <span>01</span>
              <p>Describe the operation and the work required.</p>
            </li>
            <li>
              <span>02</span>
              <p>We review the systems, constraints and delivery path.</p>
            </li>
            <li>
              <span>03</span>
              <p>You receive a proposed scope, timing and quotation.</p>
            </li>
          </ol>
        </div>
        <ProjectEnquiryForm mode="quote" />
      </section>
    </LabsInnerShell>
  );
}
