import type { Metadata } from "next";
import { DocumentBody, InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { privacySections } from "@/content/legal-documents";

export const metadata: Metadata = {
  title: "Privacy Policy | Kasitek Labs",
};

export default function PrivacyPolicyPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Last updated: November 15, 2026"
        title={<>Privacy Policy</>}
        introduction="How KasiTek collects, uses and protects information across its websites, software, connected platforms and delivery services."
      />
      <DocumentBody sections={privacySections} />
    </LabsInnerShell>
  );
}
