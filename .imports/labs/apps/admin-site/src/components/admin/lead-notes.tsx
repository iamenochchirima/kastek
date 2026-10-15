"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Note {
  text: string;
  timestamp: string;
  adminUserName: string;
}

export default function LeadNotes({
  leadId,
  notes,
}: {
  leadId: string;
  notes: Note[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setLoading(true);

    await fetch(`/api/leads/${leadId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    });

    setText("");
    setLoading(false);
    router.refresh();
  };

  return (
    <div className="v-card p-[var(--density-card-padding)]">
      <h2 className="mb-4 text-base font-semibold tracking-[-0.01em] text-foreground">Notes</h2>

      <form onSubmit={handleAddNote} className="flex gap-3 mb-6">
        <Input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note..."
        />
        <button
          type="submit"
          disabled={loading || !text.trim()}
          className={buttonClassName({ size: "sm" })}
        >
          {loading ? "..." : "Add"}
        </button>
      </form>

      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet</p>
      ) : (
        <div className="space-y-3">
          {[...notes].reverse().map((note, i) => (
            <div key={i} className="border-l-2 border-line-strong py-1 pl-4">
              <p className="text-sm text-foreground">{note.text}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {note.adminUserName} &middot;{" "}
                {new Date(note.timestamp).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
