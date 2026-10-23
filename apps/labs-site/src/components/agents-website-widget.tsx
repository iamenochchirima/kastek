"use client";

import Script from "next/script";
import Link from "next/link";
import { useState } from "react";

export function AgentsWebsiteWidget({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <aside aria-label="Chat unavailable" className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white shadow-lg">
    <span className="text-neutral-400">Chat unavailable</span>
    <Link href="/contact" className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">Contact us</Link>
  </aside>;
  return <Script id="agents-website-widget" src={src} strategy="afterInteractive" onError={() => setFailed(true)} />;
}
