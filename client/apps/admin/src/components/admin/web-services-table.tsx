"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import ConfirmModal from "./confirm-modal";
import EditFieldModal from "./edit-field-modal";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-white/5 text-text-faint",
  called: "bg-blue-500/15 text-blue-400",
  interested: "bg-green-500/15 text-green-400",
  not_interested: "bg-yellow-500/15 text-yellow-400",
  no_answer: "bg-red-500/15 text-red-400",
  callback: "bg-purple-500/15 text-purple-400",
  dead: "bg-zinc-500/15 text-zinc-400",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  called: "Called",
  interested: "Interested",
  not_interested: "Not Interested",
  no_answer: "No Answer",
  callback: "Callback",
  dead: "Dead",
};

const CALL_STATUSES = ["pending", "called", "interested", "not_interested", "no_answer", "callback", "dead"];

type Lead = {
  id: string;
  businessName: string;
  website: string | null;
  address: string | null;
  bizbayUrl: string | null;
  category: string;
  phone: string | null;
  email: string | null;
  callStatus: string;
  notes: string | null;
  callbackDate: string | null;
};

export default function WebServicesTable({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const allSelected = leads.length > 0 && selected.size === leads.length;

  async function updateLead(id: string, data: Record<string, unknown>) {
    const scrollY = window.scrollY;
    await fetch(`/api/web-services/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    router.refresh();
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  async function bulkUpdateStatus(status: string) {
    setUpdating(true);
    await Promise.all(
      Array.from(selected).map((id) => updateLead(id, { callStatus: status }))
    );
    setSelected(new Set());
    setSelectMode(false);
    setUpdating(false);
  }

  async function handleBulkDelete() {
    setUpdating(true);
    await Promise.all(
      Array.from(selected).map((id) =>
        fetch(`/api/web-services/${id}`, { method: "DELETE" })
      )
    );
    setSelected(new Set());
    setSelectMode(false);
    setShowDeleteModal(false);
    setUpdating(false);
    router.refresh();
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {!selectMode ? (
          <button
            onClick={() => setSelectMode(true)}
            className="text-xs font-medium text-text-muted hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-surface-overlay transition-colors"
          >
            Select
          </button>
        ) : (
          <>
            <button
              onClick={() => { setSelectMode(false); setSelected(new Set()); }}
              className="text-xs font-medium text-text-muted hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-text-muted">{selected.size} selected:</span>
                {CALL_STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => bulkUpdateStatus(s)}
                    disabled={updating}
                    className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 ${STATUS_COLORS[s]} hover:opacity-80`}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                ))}
                <button
                  onClick={() => setShowDeleteModal(true)}
                  disabled={updating}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50"
                >
                  Delete
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        {leads.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-text-faint">No leads found</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface-overlay">
                {selectMode && (
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)))}
                      className="rounded border-border accent-primary"
                    />
                  </th>
                )}
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">Business</th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">Phone</th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">Email</th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">Status</th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={`hover:bg-surface-overlay transition-colors ${selectMode && selected.has(lead.id) ? "bg-primary/5" : ""}`}
                >
                  {selectMode && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            next.has(lead.id) ? next.delete(lead.id) : next.add(lead.id);
                            return next;
                          });
                        }}
                        className="rounded border-border accent-primary"
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    {lead.bizbayUrl ? (
                      <a
                        href={lead.bizbayUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary group"
                      >
                        <p className="font-medium text-sm text-text group-hover:text-primary transition-colors">{lead.businessName}</p>
                        {lead.address && <p className="text-text-faint text-xs">{lead.address}</p>}
                      </a>
                    ) : (
                      <div>
                        <p className="font-medium text-sm text-text">{lead.businessName}</p>
                        {lead.address && <p className="text-text-faint text-xs">{lead.address}</p>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <EditableField
                      id={lead.id}
                      field="phone"
                      value={lead.phone}
                      placeholder="Add phone..."
                      type="tel"
                      label="Phone Number"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <EditableField
                      id={lead.id}
                      field="email"
                      value={lead.email}
                      placeholder="Add email..."
                      type="email"
                      label="Email Address"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <StatusDropdown
                      value={lead.callStatus}
                      onChange={(status) => updateLead(lead.id, { callStatus: status })}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <EditableField
                      id={lead.id}
                      field="notes"
                      value={lead.notes}
                      placeholder="Add note..."
                      label="Notes"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ConfirmModal
        open={showDeleteModal}
        title="Delete Selected Leads"
        message={`This will permanently delete ${selected.size} selected lead${selected.size !== 1 ? "s" : ""}. This action cannot be undone.`}
        confirmLabel={`Delete ${selected.size}`}
        loading={updating}
        onConfirm={handleBulkDelete}
        onCancel={() => setShowDeleteModal(false)}
      />
    </>
  );
}

function StatusDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, dropUp: false });
  const btnRef = useRef<HTMLButtonElement>(null);

  function handleOpen() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < 200;
      setPos({
        top: dropUp ? rect.top : rect.bottom + 4,
        left: rect.left,
        dropUp,
      });
    }
    setOpen(!open);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={`text-xs font-medium px-2.5 py-1 rounded-full cursor-pointer ${STATUS_COLORS[value] || ""}`}
      >
        {STATUS_LABELS[value] || value}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 bg-surface-raised border border-border rounded-lg shadow-lg py-1 min-w-36"
            style={{
              left: pos.left,
              ...(pos.dropUp
                ? { bottom: window.innerHeight - pos.top + 4 }
                : { top: pos.top }),
            }}
          >
            {CALL_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => { onChange(s); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-surface-overlay transition-colors flex items-center gap-2 ${
                  s === value ? "text-primary" : "text-text-muted"
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[s]?.split(" ")[0] || "bg-white/10"}`} />
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function EditableField({
  id,
  field,
  value,
  placeholder,
  type = "text",
  label,
}: {
  id: string;
  field: string;
  value: string | null;
  placeholder: string;
  type?: string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(newValue: string) {
    setSaving(true);
    const scrollY = window.scrollY;
    await fetch(`/api/web-services/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: newValue || null }),
    });
    setSaving(false);
    setOpen(false);
    router.refresh();
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-text-muted hover:text-text truncate block max-w-40 text-left"
      >
        {value || placeholder}
      </button>
      <EditFieldModal
        open={open}
        title={label || `Edit ${field}`}
        value={value || ""}
        placeholder={placeholder}
        type={field === "notes" ? "textarea" : type}
        loading={saving}
        onSave={save}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
