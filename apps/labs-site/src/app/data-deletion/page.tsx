import type { Metadata } from "next";
import { DocumentBody, InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { deletionSections } from "@/content/legal-documents";

export const metadata: Metadata = {
  title: "Data Deletion | Kasitek Labs",
};

export default function DataDeletionPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Last updated: March 2, 2026"
        title={<>Data Deletion Request</>}
        introduction="How to request deletion of information associated with a KasiTek account, workspace or connected service."
        action={{
          label: "Email a deletion request",
          href: "mailto:info@kasitek.co.za?subject=Data%20Deletion%20Request",
        }}
      />
      <DocumentBody sections={deletionSections} />
    </LabsInnerShell>
  );
}
