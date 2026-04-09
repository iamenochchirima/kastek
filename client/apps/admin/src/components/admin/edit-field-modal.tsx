"use client";

import { useState, useEffect, useRef } from "react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-surface-raised border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
        <h3 className="text-sm font-semibold text-text mb-3">{title}</h3>
        {isTextarea ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            rows={3}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={type}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSave(input)}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        )}
        <div className="flex justify-end gap-3 mt-4">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-text-muted hover:text-text rounded-lg hover:bg-surface-overlay transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(input)}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary-dark rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
