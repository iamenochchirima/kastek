import { ApiReferencePageClient } from "@/components/dashboard/developers/api-reference-page-client";

export function meta() { return [{ title: "API | Developers | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function DevelopersApiPage() {
  return <ApiReferencePageClient />;
}
