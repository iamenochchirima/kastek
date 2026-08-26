"use client";

import { useEffect } from "react";
import { buttonClassName } from "@/components/ui/button";

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center p-4" role="presentation">
      <div className="fixed inset-0 bg-overlay/70 backdrop-blur-sm" onClick={onCancel} />
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" className="relative w-full max-w-sm rounded-[calc(var(--radius)-1px)] border border-line bg-card p-[var(--density-card-padding)] shadow-pop">
        <h3 id="confirm-modal-title" className="text-base font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className={buttonClassName({ variant: "ghost", size: "md" })}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={buttonClassName({ variant: "destructive", size: "md" })}
          >
            {loading ? "Deleting..." : confirmLabel || "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
