import WebServicesImportForm from "@/components/admin/web-services-import-form";

export default function WebServicesImportPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-text">Import Web Service Leads</h1>
      <p className="text-text-muted text-sm">
        Upload a JSON file of businesses without working websites to start cold calling.
      </p>
      <WebServicesImportForm />
    </div>
  );
}
