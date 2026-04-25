"use client";

import Link from "next/link";

export function BrochureActions() {
  return (
    <div className="fixed right-4 top-4 z-50 flex gap-3 print:hidden">
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-full bg-zinc-950 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-black/20 transition hover:bg-zinc-800"
      >
        Download PDF
      </button>
      <Link
        href="/solutions"
        className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50"
      >
        Back to solutions
      </Link>
    </div>
  );
}
