"use client";

import { buttonClassName } from "@/components/ui/button";

export default function AdminError({ reset }: { reset: () => void }) {
  return <section className="v-card space-y-4 p-6" role="alert"><h1 className="text-lg font-semibold">Unable to load this page</h1><p className="text-sm text-muted-foreground">The service is unavailable or access was denied.</p><button onClick={reset} className={buttonClassName()}>Retry</button></section>;
}
