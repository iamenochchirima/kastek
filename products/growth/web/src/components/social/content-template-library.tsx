import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ContentWorkspaceNavigation } from "./content-workspace-navigation";
import { AssetPreview, MediaPicker } from "./content-media-library";
import {
  contentOperation,
  errorMessage,
  getEditablePost,
  type ContentTemplate,
  type LibraryPage,
} from "@/lib/content-library";

const emptyTemplate = {
  name: "",
  description: "",
  category: "",
  content: "",
  channels: [] as string[],
  variants: [] as ContentTemplate["variants"],
  fields: [] as ContentTemplate["fields"],
  media: [] as ContentTemplate["media"],
};
const platforms = [
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "TIKTOK",
  "LINKEDIN",
  "X",
  "BLUESKY",
];
export function ContentTemplateLibrary() {
  const navigate = useNavigate();
  const detailRef = useRef<HTMLElement>(null);
  const readVersion = useRef(0);
  const [params] = useSearchParams();
  const sourcePostId = params.get("sourcePostId");
  const templateId = params.get("template");
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [archived, setArchived] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ContentTemplate | null>(null);
  useEffect(() => {
    if (selected && window.innerWidth < 1024)
      detailRef.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }, [selected]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<string | null>(null);
  const [renderedPlatforms, setRenderedPlatforms] = useState<
    ContentTemplate["variants"]
  >([]);
  const [renderErrors, setRenderErrors] = useState<string[]>([]);
  const [renderReady, setRenderReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!!sourcePostId);
  const [form, setForm] = useState<
    typeof emptyTemplate & { id?: string; revision?: number }
  >(emptyTemplate);
  const [sourceLoading, setSourceLoading] = useState(!!sourcePostId);
  useEffect(() => {
    if (!sourcePostId) return;
    let active = true;
    void getEditablePost(sourcePostId)
      .then((post) => {
        if (active)
          setForm({
            ...emptyTemplate,
            name: post.title || "",
            content: post.content,
            channels: post.channels,
            variants: (post.variants || []).map(({ platform, content }) => ({
              platform,
              content,
            })),
            media: (post.media || []).map(
              ({ assetId, sortOrder, altText }) => ({
                assetId,
                sortOrder,
                altText,
              }),
            ),
          });
      })
      .catch((e) => active && setError(errorMessage(e)))
      .finally(() => active && setSourceLoading(false));
    return () => {
      active = false;
    };
  }, [sourcePostId]);
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const fieldProblems = form.fields.map((field, index) =>
    !/^([A-Za-z][A-Za-z0-9_]{0,63})$/.test(field.key)
      ? "Use a valid variable key."
      : !field.label.trim()
        ? "Enter a label."
        : form.fields.some((item, i) => i !== index && item.key === field.key)
          ? "Variable keys must be unique."
          : "",
  );
  const knownKeys = new Set(form.fields.map((field) => field.key));
  const captions = [
    form.content,
    ...form.variants.map((variant) => variant.content),
  ].join("\n");
  const missingKey = [
    ...captions.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g),
  ].find((match) => !knownKeys.has(match[1]!))?.[1];
  const malformedCaption = captions
    .replace(/\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\}/g, "")
    .match(/\{\{|\}\}/);
  const captionProblem = malformedCaption
    ? "Use variables such as {{name}}."
    : missingKey
      ? `Add the ${missingKey} variable.`
      : "";
  const formInvalid =
    !form.name.trim() ||
    !form.channels.length ||
    fieldProblems.some(Boolean) ||
    !!captionProblem;
  const load = useCallback(
    async (cursor?: string) => {
      const version = ++readVersion.current;
      setLoading(true);
      setError("");
      try {
        const result = await contentOperation<
          LibraryPage<{ templates: ContentTemplate[] }>
        >("content.templates.list", {
          limit: 24,
          ...(search ? { search } : {}),
          ...(category ? { category } : {}),
          archived,
          ...(cursor ? { cursor } : {}),
        });
        if (version !== readVersion.current) return;
        setTemplates((current) =>
          cursor ? [...current, ...result.templates] : result.templates,
        );
        setNext(result.pagination.nextCursor);
      } catch (e) {
        if (version === readVersion.current) setError(errorMessage(e));
      } finally {
        if (version === readVersion.current) setLoading(false);
      }
    },
    [search, archived, category],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!templateId) return;
    let active = true;
    void contentOperation<{ template: ContentTemplate }>(
      "content.templates.get",
      { templateId },
    )
      .then(({ template }) => {
        if (active) {
          setSelected(template);
          setValues(
            Object.fromEntries(
              template.fields.map((field) => [
                field.key,
                field.defaultValue || "",
              ]),
            ),
          );
        }
      })
      .catch((error) => active && setError(errorMessage(error)));
    return () => {
      active = false;
    };
  }, [templateId]);
  function select(template: ContentTemplate) {
    setSelected(template);
    setValues(
      Object.fromEntries(
        template.fields.map((field) => [field.key, field.defaultValue || ""]),
      ),
    );
    setRendered(null);
    setRenderErrors([]);
    setRenderReady(null);
    setError("");
  }
  function edit(template?: ContentTemplate) {
    setSubmitAttempted(false);
    setForm(
      template
        ? {
            ...emptyTemplate,
            ...template,
            description: template.description || "",
            category: template.category || "",
          }
        : emptyTemplate,
    );
    if (!template && sourcePostId)
      navigate("/content/templates", { replace: true });
    setEditing(true);
  }
  async function save() {
    setSubmitAttempted(true);
    if (formInvalid) return;
    setBusy(true);
    setError("");
    try {
      const definition = {
        name: form.name,
        description: form.description,
        category: form.category,
        content: form.content,
        channels: form.channels,
        variants: form.variants,
        media: form.media,
        fields: form.fields.map((field) => ({
          ...field,
          defaultValue: field.defaultValue || undefined,
        })),
      };
      const result = await contentOperation<{ template: ContentTemplate }>(
        !!form.id ? "content.templates.update" : "content.templates.create",
        form.id
          ? {
              templateId: selected?.id,
              expectedRevision: selected?.revision,
              template: definition,
            }
          : { template: definition, ...(sourcePostId ? { sourcePostId } : {}) },
        crypto.randomUUID(),
      );
      setEditing(false);
      navigate(`/content/templates?template=${result.template.id}`, {
        replace: true,
      });
      select(result.template);
      void load();
      toast.success("Template saved");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function applyTemplate(preview = false) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await contentOperation<{
        post?: { id: string };
        postId?: string;
        rendered?: {
          content: string;
          channels: string[];
          variants: ContentTemplate["variants"];
          media: ContentTemplate["media"];
          validation?: {
            ready: boolean;
            errors: { platform?: string; code?: string; message: string }[];
          };
        };
      }>(
        `content.templates.${preview ? "render" : "instantiate"}`,
        {
          templateId: selected.id,
          expectedRevision: selected.revision,
          values,
        },
        preview ? undefined : crypto.randomUUID(),
      );
      if (preview) {
        setRendered(result.rendered?.content || "");
        if (result.rendered) {
          const output = result.rendered;
          setRenderedPlatforms(
            output.channels.map((platform) => {
              const variant = output.variants.find(
                (item) => item.platform === platform,
              );
              return {
                platform,
                content: variant?.content ?? output.content,
                media: variant?.media ?? output.media,
              };
            }),
          );
        }
        setRenderReady(result.rendered?.validation?.ready ?? true);
        setRenderErrors(
          result.rendered?.validation?.errors.map(
            (item) =>
              `${item.platform ? `${item.platform}: ` : ""}${item.message}`,
          ) || [],
        );
      } else {
        const postId = result.post?.id || result.postId;
        if (!postId)
          throw new Error("Draft created without a readable identifier.");
        toast.success("Draft created");
        navigate(`/content?edit=${postId}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await contentOperation<{ template: ContentTemplate }>(
        `content.templates.${selected.archivedAt ? "restore" : "archive"}`,
        { templateId: selected.id, expectedRevision: selected.revision },
        crypto.randomUUID(),
      );
      select(result.template);
      setConfirm(false);
      void load();
      toast.success("Template updated");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-full">
      <header className="space-y-5 border-b border-border px-4 pt-6 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Content templates
          </h1>
          <Button
            onClick={() => {
              setSelected(null);
              edit();
            }}
          >
            New template
          </Button>
        </div>
        <ContentWorkspaceNavigation active="templates" />
      </header>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
        <main className="space-y-5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="min-w-40 flex-1"
              aria-label="Search templates"
              placeholder="Search templates"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Input
              className="w-40"
              aria-label="Filter category"
              placeholder="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Archived
            </label>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {templates.map((template) => (
              <button
                key={template.id}
                className={`min-w-0 rounded-xl border p-5 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary ${selected?.id === template.id ? "border-primary bg-primary/5" : "border-border"}`}
                onClick={() => select(template)}
              >
                {template.media[0] ? (
                  <AssetPreview
                    assetId={template.media[0].assetId}
                    className="mb-4 aspect-[4/3] rounded-lg"
                  />
                ) : null}
                <div className="mb-4 line-clamp-5 min-h-28 whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm text-muted-foreground">
                  {template.content || "No caption"}
                </div>
                <h2 className="truncate font-medium">{template.name}</h2>
                {template.category ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {template.category}
                  </p>
                ) : null}
                <p className="mt-3 truncate text-xs text-muted-foreground">
                  {template.channels.join(" · ")}
                </p>
              </button>
            ))}
            {loading && !templates.length
              ? Array.from({ length: 6 }, (_, i) => (
                  <div
                    key={i}
                    className="h-64 animate-pulse rounded-xl bg-muted"
                  />
                ))
              : null}
          </div>
          {!loading && !templates.length ? (
            <div className="py-16 text-center">
              <p className="mb-4 text-muted-foreground">No templates yet</p>
              <Button
                onClick={() => {
                  setSelected(null);
                  edit();
                }}
              >
                New template
              </Button>
            </div>
          ) : null}
          {next ? (
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void load(next)}
            >
              Load more
            </Button>
          ) : null}
        </main>
        {selected ? (
          <aside
            ref={detailRef}
            className="space-y-5 border-t border-border p-4 sm:p-6 lg:border-l lg:border-t-0"
          >
            <Button
              className="lg:hidden"
              variant="ghost"
              onClick={() => setSelected(null)}
            >
              Back to templates
            </Button>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold">{selected.name}</h2>
              <Button size="sm" variant="ghost" onClick={() => edit(selected)}>
                Edit
              </Button>
            </div>
            {selected.description ? (
              <p className="text-sm text-muted-foreground">
                {selected.description}
              </p>
            ) : null}
            {selected.fields.map((field) => (
              <label key={field.key} className="block space-y-2 text-sm">
                {field.label}
                {field.required ? " *" : ""}
                <Input
                  value={values[field.key] || ""}
                  onChange={(e) => {
                    setValues((current) => ({
                      ...current,
                      [field.key]: e.target.value,
                    }));
                    setRendered(null);
                    setRenderErrors([]);
                    setRenderReady(null);
                  }}
                  required={field.required}
                />
              </label>
            ))}
            {rendered === null ? (
              <div className="whitespace-pre-wrap rounded-xl bg-muted p-4 text-sm">
                {selected.content}
              </div>
            ) : (
              renderedPlatforms.map((variant) => (
                <section key={variant.platform} className="space-y-3">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {variant.platform}
                  </h3>
                  <p className="whitespace-pre-wrap rounded-xl bg-muted p-4 text-sm">
                    {variant.content}
                  </p>
                  {variant.media?.map((media) => (
                    <AssetPreview key={media.assetId} assetId={media.assetId} />
                  ))}
                </section>
              ))
            )}
            {renderErrors.length ? (
              <ul role="alert" className="space-y-1 text-sm text-destructive">
                {renderErrors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            ) : null}
            {rendered === null && selected.media[0] ? (
              <AssetPreview assetId={selected.media[0].assetId} />
            ) : null}
            {selected.media.length ? (
              <p className="text-sm text-muted-foreground">
                {selected.media.length} media attachment
                {selected.media.length === 1 ? "" : "s"}
              </p>
            ) : null}
            <Button
              className="w-full"
              disabled={
                busy ||
                !!selected.archivedAt ||
                selected.fields.some(
                  (field) =>
                    field.required && !(values[field.key] || "").trim(),
                )
              }
              onClick={() => void applyTemplate(true)}
            >
              Preview
            </Button>
            <Button
              className="w-full"
              disabled={
                busy ||
                renderReady === false ||
                !!selected.archivedAt ||
                selected.fields.some(
                  (field) =>
                    field.required && !(values[field.key] || "").trim(),
                )
              }
              onClick={() => void applyTemplate()}
            >
              {busy ? "Working…" : "Create draft"}
            </Button>
            <Button
              className="w-full"
              variant="ghost"
              onClick={() => setConfirm(true)}
            >
              {selected.archivedAt ? "Restore template" : "Archive template"}
            </Button>
          </aside>
        ) : null}
      </div>
      <Dialog open={editing} onOpenChange={(open) => !busy && setEditing(open)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit template" : "New template"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Save a reusable post format.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="block space-y-2 text-sm">
              Name
              <Input
                value={form.name}
                aria-invalid={submitAttempted && !form.name.trim()}
                maxLength={240}
                required
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              {submitAttempted && !form.name.trim() ? (
                <span role="alert" className="block text-xs text-destructive">
                  Enter a name.
                </span>
              ) : null}
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-2 text-sm">
                Category
                <Input
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                />
              </label>
              <label className="block space-y-2 text-sm">
                Description
                <Input
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="block space-y-2 text-sm">
              Caption
              <Textarea
                rows={5}
                value={form.content}
                maxLength={32768}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="Use {{name}} for a variable"
                aria-invalid={submitAttempted && !!captionProblem}
              />
              {submitAttempted && captionProblem ? (
                <span role="alert" className="block text-xs text-destructive">
                  {captionProblem}
                </span>
              ) : null}
            </label>
            <fieldset>
              <legend className="mb-2 text-sm">Platforms</legend>
              <div className="flex flex-wrap gap-3">
                {platforms.map((platform) => (
                  <label
                    className="flex items-center gap-1.5 text-xs"
                    key={platform}
                  >
                    <input
                      type="checkbox"
                      checked={form.channels.includes(platform)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          channels: e.target.checked
                            ? [...form.channels, platform]
                            : form.channels.filter((p) => p !== platform),
                          variants: e.target.checked
                            ? form.variants
                            : form.variants.filter(
                                (v) => v.platform !== platform,
                              ),
                        })
                      }
                    />
                    {platform}
                  </label>
                ))}
              </div>
              {submitAttempted && !form.channels.length ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  Choose a platform.
                </p>
              ) : null}
            </fieldset>
            <div className="space-y-3">
              {form.channels.map((platform) => (
                <label key={platform} className="block space-y-2 text-sm">
                  {platform} caption
                  <Textarea
                    value={
                      form.variants.find((v) => v.platform === platform)
                        ?.content ?? ""
                    }
                    placeholder="Use main caption"
                    onChange={(e) =>
                      setForm({
                        ...form,
                        variants: e.target.value
                          ? [
                              ...form.variants.filter(
                                (v) => v.platform !== platform,
                              ),
                              {
                                ...form.variants.find(
                                  (v) => v.platform === platform,
                                ),
                                platform,
                                content: e.target.value,
                              },
                            ]
                          : form.variants.find((v) => v.platform === platform)
                                ?.media !== undefined
                            ? form.variants.map((v) =>
                                v.platform === platform
                                  ? { ...v, content: form.content }
                                  : v,
                              )
                            : form.variants.filter(
                                (v) => v.platform !== platform,
                              ),
                      })
                    }
                  />
                </label>
              ))}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Variables</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm({
                      ...form,
                      fields: [
                        ...form.fields,
                        { key: "", label: "", required: true },
                      ],
                    })
                  }
                >
                  Add variable
                </Button>
              </div>
              {form.fields.map((field, index) => (
                <div
                  key={index}
                  className="grid grid-cols-2 gap-2 rounded-lg border p-3"
                >
                  {submitAttempted && fieldProblems[index] ? (
                    <p
                      role="alert"
                      className="col-span-2 text-xs text-destructive"
                    >
                      {fieldProblems[index]}
                    </p>
                  ) : null}
                  <Input
                    aria-label="Variable key"
                    placeholder="key"
                    value={field.key}
                    required
                    pattern="[a-zA-Z][a-zA-Z0-9_]*"
                    onChange={(e) =>
                      setForm({
                        ...form,
                        fields: form.fields.map((f, i) =>
                          i === index ? { ...f, key: e.target.value } : f,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="Variable label"
                    placeholder="Label"
                    value={field.label}
                    required
                    onChange={(e) =>
                      setForm({
                        ...form,
                        fields: form.fields.map((f, i) =>
                          i === index ? { ...f, label: e.target.value } : f,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="Default value"
                    placeholder="Default value"
                    value={field.defaultValue || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        fields: form.fields.map((f, i) =>
                          i === index
                            ? { ...f, defaultValue: e.target.value }
                            : f,
                        ),
                      })
                    }
                  />
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={!!field.required}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            fields: form.fields.map((f, i) =>
                              i === index
                                ? { ...f, required: e.target.checked }
                                : f,
                            ),
                          })
                        }
                      />
                      Required
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setForm({
                          ...form,
                          fields: form.fields.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPicker(true)}
              >
                Add media
              </Button>
              {form.media.map((media, index) => (
                <div
                  key={media.assetId}
                  className="space-y-3 rounded-lg border border-border p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">Attachment {index + 1}</span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        onClick={() => {
                          const media = [...form.media];
                          [media[index - 1], media[index]] = [
                            media[index]!,
                            media[index - 1]!,
                          ];
                          setForm({
                            ...form,
                            media: media.map((item, sortOrder) => ({
                              ...item,
                              sortOrder,
                            })),
                          });
                        }}
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setForm({
                            ...form,
                            media: form.media.filter(
                              (m) => m.assetId !== media.assetId,
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <AssetPreview
                    assetId={media.assetId}
                    className="h-24 w-24 rounded-lg"
                  />
                  <Input
                    aria-label={`Attachment ${index + 1} alt text`}
                    placeholder="Alt text"
                    value={media.altText || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        media: form.media.map((m) =>
                          m.assetId === media.assetId
                            ? { ...m, altText: e.target.value }
                            : m,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button disabled={busy || sourceLoading}>
                {busy ? "Saving…" : "Save template"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <MediaPicker
        open={picker}
        onOpenChange={setPicker}
        selectedIds={form.media.map((m) => m.assetId)}
        validateSelection={(asset) =>
          form.media.some((media) => media.assetId === asset.id) ||
          form.media.length < 20
            ? null
            : "A template supports up to 20 media attachments."
        }
        onSelect={(asset) =>
          setForm((current) =>
            current.media.some((media) => media.assetId === asset.id)
              ? current
              : {
                  ...current,
                  media: [
                    ...current.media,
                    {
                      assetId: asset.id,
                      sortOrder: current.media.length,
                      altText: asset.defaultAltText,
                    },
                  ],
                },
          )
        }
      />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selected?.archivedAt ? "Restore template?" : "Archive template?"}
            </DialogTitle>
            <DialogDescription>
              Existing drafts and published posts stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void archive()}>
              {busy ? "Saving…" : selected?.archivedAt ? "Restore" : "Archive"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
