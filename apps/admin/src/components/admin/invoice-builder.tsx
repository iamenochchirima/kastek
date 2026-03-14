"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  applyTemplateToDraft,
  formatInvoiceDateInput,
  getServiceLabel,
  INVOICE_DEFAULT_SECTION_ORDER,
  INVOICE_SERVICE_TYPES,
  INVOICE_STATUSES,
  type InvoiceDraft,
  type InvoiceSection,
} from "@/lib/invoice";

type Props = {
  mode: "create" | "edit";
  initialDraft: InvoiceDraft;
};

type PricingItemState = {
  id: string;
  description: string;
  amount: string;
  billing: string;
};

type SectionState = {
  id: string;
  title: string;
  content: string;
  format: "richtext" | "markdown";
};

type ServiceFieldKey = "included" | "features" | "maintenance";

type ServiceState = {
  id: "service_1" | "service_2";
  title: string;
  included: string;
  features: string;
  maintenance: string;
};

type NoteSectionState = {
  id: string;
  title: string;
  items: string;
};

type SectionOrderId = `custom:${string}`;
type EditableFieldKey = "termsAndNotes";
type EditorTarget =
  | { type: "field"; key: EditableFieldKey; title: string }
  | { type: "summary"; title: string }
  | { type: "service"; serviceId: ServiceState["id"]; field: ServiceFieldKey; title: string }
  | { type: "custom"; id: string; title: string }
  | { type: "note"; id: string; title: string };

const SERVICE_TWO_INCLUDED_ID = "service_2_included";
const SERVICE_TWO_FEATURES_ID = "service_2_features";
const SERVICE_TWO_MAINTENANCE_ID = "service_2_maintenance";
const SERVICE_ONE_TITLE_ID = "service_1_title";
const SERVICE_TWO_SECTION_IDS = new Set([
  SERVICE_TWO_INCLUDED_ID,
  SERVICE_TWO_FEATURES_ID,
  SERVICE_TWO_MAINTENANCE_ID,
]);

function toTextAreaValue(items: string[]) {
  return items.join("\n");
}

function fromTextAreaValue(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createPricingItemId() {
  return `item_${Math.random().toString(36).slice(2, 10)}`;
}

function createSectionId() {
  return `section_${Math.random().toString(36).slice(2, 10)}`;
}

function createNoteSectionId() {
  return `note_${Math.random().toString(36).slice(2, 10)}`;
}

function toCustomSectionOrderId(id: string): SectionOrderId {
  return `custom:${id}`;
}

function toPricingItemState(items: InvoiceDraft["pricingItems"]): PricingItemState[] {
  return items.map((item) => ({
    id: createPricingItemId(),
    description: item.description,
    amount: item.amount,
    billing: item.billing,
  }));
}

function toSectionState(items: InvoiceDraft["customSections"]): SectionState[] {
  return items.map((item) => ({
    id: item.id || createSectionId(),
    title: item.title,
    content: item.content,
    format: item.format || "richtext",
  })).filter((item) => !SERVICE_TWO_SECTION_IDS.has(item.id) && item.id !== SERVICE_ONE_TITLE_ID);
}

function toNoteSectionState(items: InvoiceDraft["noteSections"]): NoteSectionState[] {
  return items.map((item) => ({
    id: item.id || createNoteSectionId(),
    title: item.title,
    items: toTextAreaValue(item.items),
  }));
}

function isHtmlContent(value: string) {
  return /<[^>]+>/.test(value);
}

function toServiceState(draft: InvoiceDraft): ServiceState[] {
  const customById = new Map(draft.customSections.map((section) => [section.id, section]));
  const serviceOneTitle = customById.get(SERVICE_ONE_TITLE_ID)?.title?.trim() || "Service 1";
  const serviceTwoTitle =
    customById.get(SERVICE_TWO_INCLUDED_ID)?.title.split(" - ")[0]?.trim() ||
    customById.get(SERVICE_TWO_FEATURES_ID)?.title.split(" - ")[0]?.trim() ||
    customById.get(SERVICE_TWO_MAINTENANCE_ID)?.title.split(" - ")[0]?.trim() ||
    "Service 2";

  return [
    {
      id: "service_1",
      title: serviceOneTitle,
      included: linesValueToHtml(toTextAreaValue(draft.scopeOfWork)),
      features: linesValueToHtml(toTextAreaValue(draft.deliverables)),
      maintenance: linesValueToHtml(toTextAreaValue(draft.maintenanceIncludes)),
    },
    {
      id: "service_2",
      title: serviceTwoTitle,
      included: customById.get(SERVICE_TWO_INCLUDED_ID)?.content || "<p></p>",
      features: customById.get(SERVICE_TWO_FEATURES_ID)?.content || "<p></p>",
      maintenance: customById.get(SERVICE_TWO_MAINTENANCE_ID)?.content || "<p></p>",
    },
  ];
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoneyAmount(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const normalized = raw.replace(/[^0-9,.-]/g, "");
  if (!normalized) return null;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");
  if (hasComma && hasDot) {
    const parsed = Number.parseFloat(normalized.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (hasComma && !hasDot) {
    const parsed = Number.parseFloat(normalized.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeInvoiceTotal(items: Array<{ amount: string; billing: string }>) {
  let total = 0;
  let counted = 0;
  for (const item of items) {
    const amount = parseMoneyAmount(item.amount);
    if (amount === null) continue;
    total += amount;
    counted += 1;
  }

  if (counted < 1) return null;
  return total;
}

function formatZar(value: number) {
  const [whole, decimal] = value.toFixed(2).split(".");
  const withSpaces = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `R${withSpaces}.${decimal}`;
}

function sanitizeRichText(html: string) {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
}

function toSectionPayload(items: SectionState[]): InvoiceSection[] {
  return items
    .map((item) => ({
      id: item.id,
      title: item.title.trim(),
      content: item.format === "markdown" ? item.content : sanitizeRichText(item.content),
      format: item.format,
    }))
    .filter((item) =>
      item.title ||
      (item.format === "markdown" ? item.content.trim().length > 0 : stripHtml(item.content).length > 0)
    );
}

function toNoteSectionPayload(items: NoteSectionState[]) {
  return items
    .map((item) => ({
      id: item.id,
      title: item.title.trim(),
      items: fromTextAreaValue(item.items),
    }))
    .filter((item) => item.title || item.items.length > 0);
}

type RichTextEditorProps = {
  value: string;
  onChange: (next: string) => void;
};

function RichTextEditor({ value, onChange }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: true,
        autolink: true,
        defaultProtocol: "https",
      }),
    ],
    content: value || "<p></p>",
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      onChange(currentEditor.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    const nextValue = value || "<p></p>";
    if (editor.getHTML() === nextValue) return;
    editor.commands.setContent(nextValue, { emitUpdate: false });
  }, [editor, value]);

  function setLink() {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Enter link URL", previousUrl || "https://");
    if (url === null) return;

    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  const toolbarButtonClass =
    "px-2 py-1 rounded border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  if (!editor) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 overflow-hidden">
        <div className="px-3 py-2 text-xs text-text-faint border-b border-border bg-surface">
          Loading editor...
        </div>
        <div className="min-h-[220px] px-3 py-2 text-sm text-text-faint">Preparing rich text editor...</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 overflow-hidden">
      <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2 bg-surface">
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={!editor.can().chain().focus().toggleBold().run()}
          className={`${toolbarButtonClass} ${
            editor.isActive("bold")
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-text hover:bg-surface-overlay"
          }`}
        >
          Bold
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={!editor.can().chain().focus().toggleItalic().run()}
          className={`${toolbarButtonClass} ${
            editor.isActive("italic")
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-text hover:bg-surface-overlay"
          }`}
        >
          Italic
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`${toolbarButtonClass} ${
            editor.isActive("heading", { level: 2 })
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-text hover:bg-surface-overlay"
          }`}
        >
          Heading
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`${toolbarButtonClass} ${
            editor.isActive("bulletList")
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-text hover:bg-surface-overlay"
          }`}
        >
          Bullet List
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`${toolbarButtonClass} ${
            editor.isActive("orderedList")
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-text hover:bg-surface-overlay"
          }`}
        >
          Numbered List
        </button>
        <button
          type="button"
          onClick={setLink}
          className={`${toolbarButtonClass} ${
            editor.isActive("link")
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-text hover:bg-surface-overlay"
          }`}
        >
          Link
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().chain().focus().undo().run()}
          className={`${toolbarButtonClass} border-border text-text hover:bg-surface-overlay`}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().chain().focus().redo().run()}
          className={`${toolbarButtonClass} border-border text-text hover:bg-surface-overlay`}
        >
          Redo
        </button>
      </div>
      <EditorContent
        editor={editor}
        className="min-h-[220px] max-h-[55vh] overflow-y-auto px-3 py-2 text-sm text-text [&_.ProseMirror]:min-h-[200px] [&_.ProseMirror]:outline-none [&_.ProseMirror_h2]:text-base [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_p]:my-1 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline"
      />
    </div>
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyInlineMarkdown(line: string) {
  const escaped = escapeHtml(line);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function markdownToHtml(markdown: string) {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(`<li>${applyInlineMarkdown(lines[i].trim().replace(/^[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${applyInlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${applyInlineMarkdown(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    blocks.push(`<p>${applyInlineMarkdown(line)}</p>`);
    i += 1;
  }

  return blocks.join("");
}

function richTextToPreviewLines(content: string) {
  const withOrderedNumbers = content
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, inner) => {
      let index = 0;
      return String(inner).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_li, liContent) => {
        index += 1;
        return `<p>${index}. ${liContent}</p>`;
      });
    })
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, inner) =>
      String(inner).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "<p>$1</p>")
    );

  const text = withOrderedNumbers
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s+/, ""))
    .filter(Boolean);
}

function linesValueToHtml(value: string) {
  const lines = fromTextAreaValue(value);
  if (lines.length === 0) return "<p></p>";
  return `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function toRichTextContent(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "<p></p>";
  if (isHtmlContent(raw)) return raw;
  const paragraphs = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return "<p></p>";
  return paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function plainTextToPreviewLines(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const numbered = raw.split(/\s+(?=\d+\.\s)/g).map((line) => line.trim()).filter(Boolean);
  if (numbered.length > 1) return numbered;
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function summaryPreviewLines(value: string) {
  if (!value) return [];
  return isHtmlContent(value) ? richTextToPreviewLines(value) : plainTextToPreviewLines(value);
}

export default function InvoiceBuilder({ mode, initialDraft }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(initialDraft);
  const [pricingItems, setPricingItems] = useState<PricingItemState[]>(
    toPricingItemState(initialDraft.pricingItems)
  );
  const [draggingPriceItemId, setDraggingPriceItemId] = useState<string | null>(null);
  const [dropTargetPriceItemId, setDropTargetPriceItemId] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceState[]>(() => toServiceState(initialDraft));
  const [customSections, setCustomSections] = useState<SectionState[]>(() =>
    toSectionState(initialDraft.customSections)
  );
  const [sectionOrder, setSectionOrder] = useState<SectionOrderId[]>(() =>
    customSections.map((item) => toCustomSectionOrderId(item.id))
  );
  const [draggingSectionId, setDraggingSectionId] = useState<SectionOrderId | null>(null);
  const [dropTargetSectionId, setDropTargetSectionId] = useState<SectionOrderId | null>(null);
  const [textAreas, setTextAreas] = useState({
    termsAndNotes: toTextAreaValue(initialDraft.termsAndNotes),
  });
  const [noteSections, setNoteSections] = useState<NoteSectionState[]>(() =>
    toNoteSectionState(initialDraft.noteSections)
  );
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [nextPdfPreviewUrl, setNextPdfPreviewUrl] = useState<string | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState("");
  const [previewMode, setPreviewMode] = useState<"auto" | "manual">("manual");
  const previewPayloadRef = useRef("");
  const previewAbortRef = useRef<AbortController | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [editorContent, setEditorContent] = useState("<p></p>");
  const invoiceTotal = useMemo(() => computeInvoiceTotal(pricingItems), [pricingItems]);

  const pdfUrl = useMemo(() => {
    if (!form.id) return null;
    return `/api/invoices/${form.id}/pdf`;
  }, [form.id]);

  useEffect(() => {
    if (mode !== "create") return;
    const localToday = formatInvoiceDateInput(new Date());
    setForm((prev) => (prev.date === localToday ? prev : { ...prev, date: localToday }));
  }, [mode]);

  useEffect(() => {
    const customOrderIds = customSections.map((section) => toCustomSectionOrderId(section.id));
    setSectionOrder((prev) => {
      const base = prev.filter((id): id is SectionOrderId => customOrderIds.includes(id));
      const missingCustom = customOrderIds.filter((id) => !base.includes(id));
      return [...base, ...missingCustom];
    });
  }, [customSections]);

  function syncListField<K extends keyof typeof textAreas>(key: K, value: string) {
    setTextAreas((prev) => ({ ...prev, [key]: value }));
    setForm((prev) => ({ ...prev, [key]: fromTextAreaValue(value) }));
  }

  function applyTemplate(serviceType: string) {
    const next = applyTemplateToDraft(form, serviceType);
    setForm(next);
    setPricingItems(toPricingItemState(next.pricingItems));
    setServices(toServiceState(next));
    const nextCustomSections = toSectionState(next.customSections);
    setCustomSections(nextCustomSections);
    setSectionOrder(
      (next.sectionOrder as string[])
        .filter((id) => id.startsWith("custom:"))
        .map((id) => id as SectionOrderId)
        .filter((id) => {
          const rawId = id.replace("custom:", "");
          return !SERVICE_TWO_SECTION_IDS.has(rawId);
        })
    );
    setTextAreas({
      termsAndNotes: toTextAreaValue(next.termsAndNotes),
    });
    setNoteSections(toNoteSectionState(next.noteSections));
  }

  function updateLineItem(id: string, field: "description" | "amount" | "billing", value: string) {
    setPricingItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }

  function addLineItem() {
    setPricingItems((prev) => [
      ...prev,
      { id: createPricingItemId(), description: "", amount: "", billing: "Once-off" },
    ]);
  }

  function removeLineItem(id: string) {
    setPricingItems((prev) => prev.filter((item) => item.id !== id));
  }

  function reorderPricingItems(sourceId: string, targetId: string) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setPricingItems((prev) => {
      const sourceIndex = prev.findIndex((item) => item.id === sourceId);
      const targetIndex = prev.findIndex((item) => item.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function addCustomSection() {
    const id = createSectionId();
    setCustomSections((prev) => [
      ...prev,
      { id, title: "", content: "<ul><li></li></ul>", format: "richtext" },
    ]);
    setSectionOrder((prev) => [...prev, toCustomSectionOrderId(id)]);
  }

  function updateCustomSection(
    id: string,
    field: "title" | "content" | "format",
    value: string
  ) {
    setCustomSections((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }

  function updateService(id: ServiceState["id"], field: ServiceFieldKey | "title", value: string) {
    setServices((prev) => prev.map((service) => (service.id === id ? { ...service, [field]: value } : service)));
  }

  function removeCustomSection(id: string) {
    setCustomSections((prev) => prev.filter((item) => item.id !== id));
    setSectionOrder((prev) => prev.filter((item) => item !== toCustomSectionOrderId(id)));
  }

  function moveSection(sectionId: SectionOrderId, direction: "up" | "down") {
    setSectionOrder((prev) => {
      const index = prev.findIndex((item) => item === sectionId);
      if (index === -1) return prev;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function addNoteSection() {
    setNoteSections((prev) => [...prev, { id: createNoteSectionId(), title: "", items: "" }]);
  }

  function updateNoteSection(id: string, field: "title" | "items", value: string) {
    setNoteSections((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }

  function removeNoteSection(id: string) {
    setNoteSections((prev) => prev.filter((item) => item.id !== id));
  }

  function openEditor(target: EditorTarget, initialContent: string) {
    setEditorTarget(target);
    setEditorContent(initialContent || "<p></p>");
  }

  function closeEditor() {
    setEditorTarget(null);
    setEditorContent("<p></p>");
  }

  function saveEditorContent() {
    if (!editorTarget) return;
    const linesValue = richTextToPreviewLines(editorContent).join("\n");

    if (editorTarget.type === "summary") {
      setForm((prev) => ({ ...prev, introduction: editorContent }));
      closeEditor();
      return;
    }

    if (editorTarget.type === "field") {
      syncListField(editorTarget.key, linesValue);
      closeEditor();
      return;
    }

    if (editorTarget.type === "service") {
      updateService(editorTarget.serviceId, editorTarget.field, editorContent);
      closeEditor();
      return;
    }

    if (editorTarget.type === "custom") {
      updateCustomSection(editorTarget.id, "content", editorContent);
      updateCustomSection(editorTarget.id, "format", "richtext");
      closeEditor();
      return;
    }

    if (editorTarget.type === "note") {
      updateNoteSection(editorTarget.id, "items", linesValue);
      closeEditor();
    }
  }

  function reorderSections(sourceId: SectionOrderId, targetId: SectionOrderId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setSectionOrder((prev) => {
      const sourceIndex = prev.findIndex((item) => item === sourceId);
      const targetIndex = prev.findIndex((item) => item === targetId);
      if (sourceIndex === -1 || targetIndex === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function buildPayload(nextStatus?: string) {
    return {
      id: form.id || null,
      quoteRequestId: form.quoteRequestId || null,
      serviceType: form.serviceType,
      businessName: form.preparedFor,
      contactPerson: form.contactPerson,
      contactEmail: form.contactEmail,
      contactPhone: form.contactPhone,
      date: form.date,
      title: form.title,
      introduction: "",
      scopeOfWork: [],
      deliverables: [],
      implementationSteps: [],
      pricingItems: pricingItems.map(({ description, amount, billing }) => ({
        description,
        amount,
        billing,
      })),
      maintenanceIncludes: [],
      termsAndNotes: form.termsAndNotes,
      noteSections: [],
      sectionOrder: [...INVOICE_DEFAULT_SECTION_ORDER],
      validityDays: form.validityDays,
      status: nextStatus || form.status,
    };
  }

  async function saveInvoice(nextStatus?: string) {
    setLoading(true);
    setError("");
    const payload = buildPayload(nextStatus);

    try {
      const url = mode === "create" ? "/api/invoices" : `/api/invoices/${form.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save invoice");

      if (mode === "create") {
        router.push(`/invoices/${data.id}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save invoice");
    } finally {
      setLoading(false);
    }
  }

  async function deleteInvoice() {
    if (!form.id) return;
    setDeleting(true);
    setError("");

    const res = await fetch(`/api/invoices/${form.id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/invoices");
      router.refresh();
      return;
    }

    setDeleting(false);
    setError("Failed to delete invoice");
  }

  async function requestPdfPreview(force = false) {
    const payloadKey = JSON.stringify(buildPayload());
    if (!force && previewPayloadRef.current === payloadKey) return;

    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;

    setPdfPreviewLoading(true);
    setPdfPreviewError("");
    try {
      const res = await fetch("/api/invoices/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadKey,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Failed to generate preview PDF");
      const blob = await res.blob();
      const nextUrl = URL.createObjectURL(blob);
      previewPayloadRef.current = payloadKey;
      setNextPdfPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setPdfPreviewError(err instanceof Error ? err.message : "Preview unavailable");
    } finally {
      if (!controller.signal.aborted) setPdfPreviewLoading(false);
    }
  }

  useEffect(() => {
    if (previewMode !== "auto") return;
    const timeout = window.setTimeout(() => {
      void requestPdfPreview(false);
    }, 1000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    form.id,
    form.quoteRequestId,
    form.serviceType,
    form.preparedFor,
    form.contactPerson,
    form.contactEmail,
    form.contactPhone,
    form.date,
    form.title,
    form.introduction,
    form.termsAndNotes,
    form.validityDays,
    form.status,
    services,
    customSections,
    pricingItems,
    sectionOrder,
    noteSections,
    previewMode,
  ]);

  useEffect(() => {
    void requestPdfPreview(false);
  }, []);

  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
      setPdfPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setNextPdfPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  function renderLivePreviewPanel() {
    return (
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-text">Live PDF Preview</h3>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setPreviewMode("manual")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  previewMode === "manual"
                    ? "bg-primary/15 text-primary"
                    : "bg-surface text-text-faint hover:text-text hover:bg-surface-overlay"
                }`}
              >
                Manual
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("auto")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  previewMode === "auto"
                    ? "bg-primary/15 text-primary"
                    : "bg-surface text-text-faint hover:text-text hover:bg-surface-overlay"
                }`}
              >
                Auto
              </button>
            </div>
            <button
              type="button"
              onClick={() => void requestPdfPreview(true)}
              disabled={pdfPreviewLoading}
              className="border border-border hover:bg-surface-overlay px-3 py-1.5 rounded-lg text-xs font-medium text-text transition-colors disabled:opacity-50"
            >
              {pdfPreviewLoading ? "Refreshing..." : "Refresh PDF"}
            </button>
          </div>
        </div>

        {pdfPreviewError ? (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {pdfPreviewError}
          </div>
        ) : null}

        <div className="rounded-xl border border-border bg-surface-2 p-2">
          <div className="relative h-[70vh] rounded-lg overflow-hidden bg-white">
            {pdfPreviewUrl ? (
              <iframe
                src={pdfPreviewUrl}
                title="Live invoice PDF preview"
                className="absolute inset-0 w-full h-full bg-white"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-text-faint">
                Generating PDF preview...
              </div>
            )}
            {nextPdfPreviewUrl ? (
              <iframe
                src={nextPdfPreviewUrl}
                title="Loading invoice PDF preview"
                className="absolute inset-0 w-full h-full bg-white opacity-0 pointer-events-none"
                onLoad={() => {
                  const readyUrl = nextPdfPreviewUrl;
                  if (!readyUrl) return;
                  setPdfPreviewUrl((current) => {
                    if (current && current !== readyUrl) URL.revokeObjectURL(current);
                    return readyUrl;
                  });
                  setNextPdfPreviewUrl(null);
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg border border-danger/20">
          {error}
        </div>
      )}

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_520px] gap-6 items-start">
      <div className="bg-surface-raised rounded-xl border border-border p-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-text">Invoice Builder</h2>
            <p className="text-sm text-text-muted">
              Build a professional invoice with client details, pricing items, payment terms, and PDF output.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors whitespace-nowrap"
              >
                Download PDF
              </a>
            )}
            <button
              type="button"
              onClick={() => saveInvoice()}
              disabled={loading}
              className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? "Saving..." : mode === "create" ? "Create Invoice" : "Save Changes"}
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-[1.2fr_auto] gap-4 items-end border border-border rounded-xl p-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Invoice Template</label>
            <select
              value={form.serviceType}
              onChange={(e) => setForm({ ...form, serviceType: e.target.value })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {INVOICE_SERVICE_TYPES.map((service) => (
                <option key={service.value} value={service.value}>
                  {service.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-faint mt-1">Use a template to prefill invoice defaults and line items.</p>
          </div>
          <button
            type="button"
            onClick={() => applyTemplate(form.serviceType)}
            className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors"
          >
            Apply Template
          </button>
        </div>

        {mode === "edit" && (
          <div className="flex items-center justify-between gap-4 border border-border rounded-xl px-4 py-3">
            <div>
              <p className="text-sm font-medium text-text">Invoice Status</p>
              <p className="text-xs text-text-faint">
                Track whether the invoice is draft, sent, paid, overdue, or cancelled.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              {INVOICE_STATUSES.map((status) => (
                <button
                  key={status.value}
                  type="button"
                  onClick={() => {
                    setForm({ ...form, status: status.value });
                    void saveInvoice(status.value);
                  }}
                  disabled={loading}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                    status.value === form.status
                      ? "bg-primary/15 text-primary ring-2 ring-offset-1 ring-offset-surface-raised ring-primary/50"
                      : "bg-surface-overlay text-text-faint hover:text-text-muted hover:bg-border"
                  }`}
                >
                  {status.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-text">Billed To</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Client Business Name</label>
              <input
                type="text"
                value={form.preparedFor}
                onChange={(e) => setForm({ ...form, preparedFor: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Date</label>
              <input
                type="text"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                placeholder="YYYY-MM-DD"
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-xs text-text-faint mt-1">Use format `YYYY-MM-DD`.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Client Contact Email</label>
              <input
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Invoice Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-text">Pricing Items</h3>
            <button
              type="button"
              onClick={addLineItem}
              className="border border-border hover:bg-surface-overlay px-3 py-2 rounded-lg text-sm font-medium text-text transition-colors"
            >
              + Add Line Item
            </button>
          </div>

          <div className="space-y-3">
            {pricingItems.map((item) => (
              <div
                key={item.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!draggingPriceItemId || draggingPriceItemId === item.id) return;
                  if (dropTargetPriceItemId !== item.id) setDropTargetPriceItemId(item.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const sourceId = e.dataTransfer.getData("text/invoice-pricing-item-id");
                  reorderPricingItems(sourceId, item.id);
                  setDraggingPriceItemId(null);
                  setDropTargetPriceItemId(null);
                }}
                className={`rounded-xl border p-3 transition-colors ${
                  dropTargetPriceItemId === item.id && draggingPriceItemId !== item.id
                    ? "border-primary bg-primary/5"
                    : "border-border"
                }`}
              >
                <div className="grid md:grid-cols-[auto_1.8fr_1fr_1fr_auto] gap-3 items-center">
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      setDraggingPriceItemId(item.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/invoice-pricing-item-id", item.id);
                    }}
                    onDragEnd={() => {
                      setDraggingPriceItemId(null);
                      setDropTargetPriceItemId(null);
                    }}
                    className="h-10 w-10 rounded-lg border border-border text-text-faint hover:text-text hover:bg-surface-overlay transition-colors cursor-grab active:cursor-grabbing"
                    title="Drag to reorder pricing line"
                    aria-label="Drag to reorder pricing line"
                  >
                    ⋮⋮
                  </button>
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) => updateLineItem(item.id, "description", e.target.value)}
                    placeholder="Description"
                    className="px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="text"
                    value={item.amount}
                    onChange={(e) => updateLineItem(item.id, "amount", e.target.value)}
                    placeholder="Amount"
                    className="px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="text"
                    value={item.billing}
                    onChange={(e) => updateLineItem(item.id, "billing", e.target.value)}
                    placeholder="Billing"
                    className="px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <button
                    type="button"
                    onClick={() => removeLineItem(item.id)}
                    className="border border-red-500/30 text-red-400 hover:bg-red-500/10 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          {invoiceTotal !== null ? (
            <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3">
              <p className="text-xs text-text-faint">Auto-calculated total</p>
              <p className="text-sm font-semibold text-text mt-1">
                Total Due: {formatZar(invoiceTotal)}
              </p>
            </div>
          ) : null}
        </div>

        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <h3 className="font-semibold text-text">Terms and Notes</h3>
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
            <ul className="list-disc pl-5 text-sm text-text space-y-1">
              {fromTextAreaValue(textAreas.termsAndNotes).slice(0, 8).map((line, index) => (
                <li key={`terms-line-${index}`}>{line}</li>
              ))}
              {fromTextAreaValue(textAreas.termsAndNotes).length > 8 ? (
                <li className="text-text-faint">...</li>
              ) : null}
            </ul>
          </div>
          <button
            type="button"
            onClick={() =>
              openEditor(
                { type: "field", key: "termsAndNotes", title: "Terms and Notes" },
                linesValueToHtml(textAreas.termsAndNotes)
              )
            }
            className="border border-border px-3 py-2 rounded-lg text-sm font-medium text-text hover:bg-surface-overlay transition-colors"
          >
            Edit Content
          </button>
          <p className="text-xs text-text-faint">This section is fixed below pricing.</p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <h3 className="font-semibold text-text">Payment Terms</h3>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Due In (Days)</label>
            <input
              type="text"
              value={form.validityDays}
              onChange={(e) => setForm({ ...form, validityDays: e.target.value })}
              className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-faint mt-1">
              Used as the invoice payment term for this record.
            </p>
          </div>
        </div>

        {mode === "edit" && (
          <div className="pt-2">
            <button
              type="button"
              onClick={deleteInvoice}
              disabled={deleting}
              className="border border-red-500/30 text-red-400 hover:bg-red-500/10 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete Invoice"}
            </button>
          </div>
        )}
      </div>
      <aside className="hidden xl:block xl:sticky xl:top-6">{renderLivePreviewPanel()}</aside>
      </div>
      <div className="xl:hidden">{renderLivePreviewPanel()}</div>

      {editorTarget ? (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-surface-raised border border-border rounded-xl shadow-xl">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-text">Edit {editorTarget.title}</h3>
                <p className="text-xs text-text-faint">Rich text editor</p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                className="h-9 w-9 rounded-lg border border-border text-text-faint hover:text-text hover:bg-surface-overlay transition-colors"
                aria-label="Close editor"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-4">
              <RichTextEditor value={editorContent} onChange={setEditorContent} />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeEditor}
                  className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEditorContent}
                  className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Save Content
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
