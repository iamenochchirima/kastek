"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import ConfirmModal from "./confirm-modal";
import EditFieldModal from "./edit-field-modal";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-secondary text-muted-foreground",
  called: "bg-status-info-soft text-status-info",
  interested: "bg-status-success-soft text-status-success",
  not_interested: "bg-status-attention-soft text-status-attention",
  no_answer: "bg-status-danger-soft text-status-danger",
  callback: "bg-status-info-soft text-status-info",
  dead: "bg-secondary text-muted-foreground",
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
      <div className="flex flex-wrap items-center gap-3">
        {!selectMode ? (
          <button
            onClick={() => setSelectMode(true)}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Select
          </button>
        ) : (
          <>
            <button
              onClick={() => { setSelectMode(false); setSelected(new Set()); }}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">{selected.size} selected:</span>
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
                  className="rounded-full bg-status-danger px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  Delete
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="v-card overflow-hidden">
        {leads.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">No leads found</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="admin-table-head border-b border-line">
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
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Business</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                    className={`transition-colors hover:bg-accent ${selectMode && selected.has(lead.id) ? "bg-primary/5" : ""}`}
                >
                  {selectMode && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(lead.id)) next.delete(lead.id);
                            else next.add(lead.id);
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
                        <p className="text-sm font-medium text-foreground transition-colors group-hover:text-primary">{lead.businessName}</p>
                        {lead.address && <p className="text-xs text-muted-foreground">{lead.address}</p>}
                      </a>
                    ) : (
                      <div>
                        <p className="text-sm font-medium text-foreground">{lead.businessName}</p>
                        {lead.address && <p className="text-xs text-muted-foreground">{lead.address}</p>}
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
        className={`cursor-pointer rounded-full border border-transparent px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[value] || "bg-secondary text-muted-foreground"}`}
      >
        {STATUS_LABELS[value] || value}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[var(--z-popover)] min-w-36 rounded-md border border-line bg-popover py-1 shadow-pop"
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
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium transition-colors hover:bg-accent ${
                  s === value ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <span className={`size-2 rounded-full ${STATUS_COLORS[s]?.split(" ")[0] || "bg-secondary"}`} />
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
        className="block max-w-40 truncate text-left text-xs text-muted-foreground hover:text-foreground"
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
