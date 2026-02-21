"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ConfirmModal from "./confirm-modal";

export default function DeleteAllButton({ count }: { count: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    await fetch("/api/web-services", { method: "DELETE" });
    setDeleting(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-red-400 hover:text-red-300 px-3 py-2 rounded-lg border border-red-500/30 hover:bg-red-500/10 transition-colors"
      >
        Delete All
      </button>
      <ConfirmModal
        open={open}
        title="Delete All Leads"
        message={`This will permanently delete all ${count} web service leads. This action cannot be undone.`}
        confirmLabel="Delete All"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
