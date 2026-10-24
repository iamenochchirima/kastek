import { ApiKeysPageClient } from "@/components/dashboard/developers/api-keys-page-client";

export function meta() { return [{ title: "API Keys | Developers | KasiTek" }]; }

export default function DevelopersApiKeysPage() {
  return <ApiKeysPageClient />;
}
