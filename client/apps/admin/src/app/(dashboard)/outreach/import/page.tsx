import OutreachImportForm from "@/components/admin/outreach-import-form";

export default function ImportPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-text">Import Leads</h1>
      <p className="text-text-muted text-sm">
        Upload a crawled JSON file from scripts/bizbay-data/ to create a new
        outreach campaign.
      </p>
      <OutreachImportForm />
    </div>
  );
}
