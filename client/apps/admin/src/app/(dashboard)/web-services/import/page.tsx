import WebServicesImportForm from "@/components/admin/web-services-import-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";

export default function WebServicesImportPage() {
  return (
    <div className="admin-page max-w-4xl">
      <AdminPageHeader
        eyebrow="Web services"
        title="Import leads"
        description="Upload a JSON file of businesses without working websites."
        actions={<Link href="/web-services" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to leads</Link>}
      />
      <WebServicesImportForm />
    </div>
  );
}
