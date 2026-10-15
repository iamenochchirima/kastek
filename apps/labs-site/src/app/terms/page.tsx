import type { Metadata } from "next";
import { DocumentBody, InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { termsSections } from "@/content/legal-documents";

export const metadata: Metadata = {
  title: "Terms of Service | Kasitek Labs",
};

export default function TermsPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Last updated: March 2, 2026"
        title={<>Terms of Service</>}
        introduction="The terms that govern access to KasiTek products, connected platforms, delivery services and related work."
      />
      <DocumentBody sections={termsSections} />
    </LabsInnerShell>
  );
}
