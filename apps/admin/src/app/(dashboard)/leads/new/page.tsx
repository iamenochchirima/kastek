import LeadForm from "@/components/admin/lead-form";

export default function NewLeadPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-text">Add New Lead</h1>
      <LeadForm />
    </div>
  );
}
