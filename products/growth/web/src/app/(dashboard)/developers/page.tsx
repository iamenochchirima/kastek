import { DevelopersPageClient } from "@/components/dashboard/developers/developers-page-client";

export function meta() { return [{ title: "Developers | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function DevelopersPage() {
  return <DevelopersPageClient />;
}
