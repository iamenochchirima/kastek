import type { Metadata } from "next";
import { AgentsWebsiteWidget } from "@/components/agents-website-widget";
import { LabsLanding } from "@/components/landing/landing-page";
import { websiteWidgetConfiguration } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "KasiTek Labs | Good ideas. Real working tools.",
  description:
    "AI agents, business growth tools and white-label client workspaces, built by KasiTek Labs.",
  openGraph: {
    title: "KasiTek Labs | Good ideas. Real working tools.",
    description:
      "AI agents, business growth tools and white-label client workspaces, built by KasiTek Labs.",
    type: "website",
  },
};

export default function LabsLandingPage() {
  return (
    <>
      <LabsLanding />
      <AgentsWebsiteWidget src={websiteWidgetConfiguration(process.env)?.src ?? null} />
    </>
  );
}
