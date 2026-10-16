import { AdminAppearancePanel } from "@/components/admin/appearance-panel";
import { AdminPageHeader } from "@/components/admin/page-header";

export default function AppearanceSettingsPage() {
  return (
    <div className="admin-page">
      <AdminPageHeader
        eyebrow="Admin settings"
        title="Appearance"
        description="Theme, color, density, and interface preferences."
      />
      <div className="w-full max-w-4xl">
        <AdminAppearancePanel />
      </div>
    </div>
  );
}
