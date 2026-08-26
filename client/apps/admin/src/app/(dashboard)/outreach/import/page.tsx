import OutreachImportForm from "@/components/admin/outreach-import-form";
import { AdminPageHeader } from "@/components/admin/page-header";

export default function ImportPage() {
  return (
    <div className="admin-page max-w-3xl">
      <AdminPageHeader title="Import leads" description="Upload crawled JSON data to create an outreach campaign." />
      <OutreachImportForm />
    </div>
  );
}
