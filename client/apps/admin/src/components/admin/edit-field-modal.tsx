"use client";

import { useState, useEffect, useRef } from "react";
import { buttonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function EditFieldModal({
  open,
  title,
  value,
  placeholder,
  type = "text",
  loading,
  onSave,
  onCancel,
}: {
  open: boolean;
  title: string;
  value: string;
  placeholder?: string;
  type?: string;
  loading?: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setInput(value);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, value]);

  const isTextarea = type === "textarea";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Edit field value</DialogDescription>
        </DialogHeader>
        {isTextarea ? (
          <Textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            rows={3}
            className="resize-none"
          />
        ) : (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={type}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSave(input)}
            placeholder={placeholder}
            data-dialog-autofocus
          />
        )}
        <DialogFooter>
          <button onClick={onCancel} disabled={loading} className={buttonClassName({ variant: "ghost", size: "md" })}>Cancel</button>
          <button onClick={() => onSave(input)} disabled={loading} className={buttonClassName({ size: "md" })}>{loading ? "Saving..." : "Save"}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
