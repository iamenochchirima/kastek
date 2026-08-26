"use client";

import { useState, useEffect, useRef } from "react";
import { buttonClassName } from "@/components/ui/button";
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

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const isTextarea = type === "textarea";

  return (
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center p-4" role="presentation">
      <div className="fixed inset-0 bg-overlay/70 backdrop-blur-sm" onClick={onCancel} />
      <div role="dialog" aria-modal="true" aria-labelledby="edit-field-modal-title" className="relative w-full max-w-sm rounded-[calc(var(--radius)-1px)] border border-line bg-card p-[var(--density-card-padding)] shadow-pop">
        <h3 id="edit-field-modal-title" className="mb-3 text-base font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
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
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className={buttonClassName({ variant: "ghost", size: "md" })}
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(input)}
            disabled={loading}
            className={buttonClassName({ size: "md" })}
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
