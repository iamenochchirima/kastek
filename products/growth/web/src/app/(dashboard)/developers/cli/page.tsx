import { CliPageClient } from "@/components/dashboard/developers/cli-page-client";

export function meta() { return [{ title: "CLI | Developers | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function DevelopersCliPage() {
  return <CliPageClient />;
}
