import LeadForm from "@/components/admin/lead-form";
import { AdminPageHeader } from "@/components/admin/page-header";

export default function NewLeadPage() {
  return (
    <div className="admin-page max-w-3xl">
      <AdminPageHeader title="Add lead" description="Capture a new lead and its service interest." />
      <LeadForm />
    </div>
  );
}
