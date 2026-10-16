"use client";

import { buttonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  loading,
  confirmVariant = "destructive",
  loadingLabel = "Deleting...",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  loading?: boolean;
  confirmVariant?: "primary" | "destructive";
  loadingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button onClick={onCancel} disabled={loading} className={buttonClassName({ variant: "ghost", size: "md" })}>Cancel</button>
          <button onClick={onConfirm} disabled={loading} className={buttonClassName({ variant: confirmVariant, size: "md" })}>{loading ? loadingLabel : confirmLabel || "Delete"}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
