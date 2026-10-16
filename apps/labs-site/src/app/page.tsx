import type { Metadata } from "next";
import Script from "next/script";
import { LabsLanding } from "@/components/landing/landing-page";
import { widgetLoaderUrl } from "@/lib/site-config";

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
      <Script
        async
        src={widgetLoaderUrl}
        data-kasitek-deployment="wdg_lr8zeyraon00iopnp4sozil8"
      />
    </>
  );
}
