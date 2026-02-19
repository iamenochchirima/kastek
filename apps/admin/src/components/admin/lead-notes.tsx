"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <div className="bg-surface-raised rounded-xl border border-border p-6">
      <h2 className="font-semibold mb-4 text-text">Notes</h2>

      <form onSubmit={handleAddNote} className="flex gap-3 mb-6">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note..."
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        <button
          type="submit"
          disabled={loading || !text.trim()}
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {loading ? "..." : "Add"}
        </button>
      </form>

      {notes.length === 0 ? (
        <p className="text-text-faint text-sm">No notes yet</p>
      ) : (
        <div className="space-y-3">
          {[...notes].reverse().map((note, i) => (
            <div key={i} className="border-l-2 border-border-light pl-4 py-1">
              <p className="text-sm text-text">{note.text}</p>
              <p className="text-xs text-text-faint mt-1">
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
