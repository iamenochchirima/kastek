import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Check, FileText, GitBranch, Headphones, Plug, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, organizationPath, type Catalogue, type CatalogueItem, type Configuration, type SkillPackage } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { CuratedSkillPreview, SkillImport, SkillPreview } from "./skill-library";
import "./catalogue.css";

type CatalogueProps = {
  organizationId: string; agentId: string; kind: "tools" | "skills";
  configuration: Configuration; onChange: (value: Configuration) => void;
};

export function catalogueItemAdded(item: CatalogueItem, configuration: Configuration) {
  const selection = item.configuration;
  const ids = [...selection.tools, ...selection.connectedToolBindingIds, ...selection.skillIds];
  return ids.length > 0 && selection.tools.every(id => configuration.tools?.includes(id)) &&
    selection.connectedToolBindingIds.every(id => configuration.connectedToolBindingIds?.includes(id)) &&
    selection.skillIds.every(id => configuration.skillIds?.includes(id));
}

function CatalogueIcon({ item }: { item: CatalogueItem }) {
  const Icon = item.kind === "skill" ? FileText : item.id.includes("knowledge") ? BookOpen :
    item.id.includes("handoff") ? Headphones : item.id.includes("github") || item.id.includes("deepwiki") ? GitBranch : Plug;
  return <span className="catalogue-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.6} /></span>;
}

export function AgentCatalogue({ organizationId, agentId, kind, configuration, onChange }: CatalogueProps) {
  const navigate = useNavigate();
  const { session } = useWorkspace();
  const canReview = session.organizations.find(organization => organization.id === organizationId)?.role === "owner";
  const skillsPath = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/skills/packages`;
  const path = `${organizationPath(organizationId)}/catalogue/${kind}?agentId=${encodeURIComponent(agentId)}`;
  const [data, setData] = useState<Catalogue | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState("all");
  const [view, setView] = useState<"recommended" | "available" | "added">("recommended");
  const [preview, setPreview] = useState<CatalogueItem | null>(null);
  const [packageId, setPackageId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Catalogue>(path).then(result => { if (live) { setData(result); setError(""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, attempt]);

  function select(item: CatalogueItem, add: boolean) {
    const selected = item.configuration;
    onChange({ ...configuration,
      tools: add ? [...new Set([...(configuration.tools ?? []), ...selected.tools])] : (configuration.tools ?? []).filter(id => !selected.tools.includes(id)),
      connectedToolBindingIds: add ? [...new Set([...(configuration.connectedToolBindingIds ?? []), ...selected.connectedToolBindingIds])] : (configuration.connectedToolBindingIds ?? []).filter(id => !selected.connectedToolBindingIds.includes(id)),
      skillIds: add ? [...new Set([...(configuration.skillIds ?? []), ...selected.skillIds])] : (configuration.skillIds ?? []).filter(id => !selected.skillIds.includes(id)),
    });
  }
  function connect(item: CatalogueItem) {
    const returnTo = `/app/agents/${encodeURIComponent(agentId)}?section=${kind}`;
    const params = new URLSearchParams({ returnTo });
    const profile = item.action.connectionProfileId ?? item.requires.connectionProfiles[0];
    if (profile) params.set("profile", profile);
    if (item.action.connectionId) params.set("setup", item.action.connectionId);
    navigate(`/app/connections?${params}`);
  }
  const needle = query.trim().toLocaleLowerCase();
  const entries = data?.entries.filter(item => (view === "available" || view === "recommended" && item.recommended || view === "added" && catalogueItemAdded(item, configuration)) &&
    (kind !== "skills" || library === "all" || (library === "private" ? item.publisher.id === organizationId : item.publisher.id !== organizationId)) &&
    (!needle || `${item.name} ${item.description} ${item.publisher.name} ${item.purposes.join(" ")}`.toLocaleLowerCase().includes(needle))) ?? [];
  const selectedCount = data?.entries.filter(item => catalogueItemAdded(item, configuration)).length ?? 0;
  const title = kind === "tools" ? "Tools" : "Skills";

  function installed(skill: SkillPackage) {
    setPreview(null); setAttempt(value => value + 1);
    if (skill.reviewState === "reviewed") onChange({ ...configuration, skillIds: [...new Set([...(configuration.skillIds ?? []), skill.id])] });
    else setPackageId(skill.id);
  }
  function action(item: CatalogueItem) {
    const added = catalogueItemAdded(item, configuration);
    const actionKind = item.action.kind === "none" && item.added
      ? item.readiness.state === "needs_connection" ? "connect" : item.readiness.state === "needs_configuration" ? "configure" : "add"
      : item.action.kind;
    if (added) return <><span className="catalogue-added"><Check size={13} />Added</span><Button type="button" size="sm" variant="ghost" aria-label={`Remove ${item.name}`} onClick={() => select(item, false)}>Remove</Button></>;
    if (item.readiness.state === "unavailable" || actionKind === "none") return <span className="catalogue-unavailable">Unavailable</span>;
    if (actionKind === "connect" || actionKind === "configure" && item.requires.connectionProfiles.length) return <Button type="button" size="sm" variant="outline" aria-label={`${actionKind === "connect" ? "Connect" : "Configure"} ${item.name}`} onClick={() => connect(item)}>{actionKind === "connect" ? "Connect" : "Configure"}</Button>;
    if (actionKind === "configure") return <Button type="button" size="sm" variant="outline" aria-label={`Configure ${item.name}`} onClick={() => navigate(item.id.includes("knowledge") ? "/app/knowledge" : `/app/agents/${encodeURIComponent(agentId)}?section=configuration`)}>Configure</Button>;
    return <Button type="button" size="sm" variant="outline" aria-label={`Add ${item.name}`} onClick={() => item.source?.kind === "curated" && item.source.slug && !item.configuration.skillIds.length ? setPreview(item) : select(item, true)}>Add</Button>;
  }
  return <section className="agent-catalogue" aria-label={`${title} catalogue`}>
    <div className="catalogue-toolbar"><nav className="catalogue-views" aria-label={`${title} view`}>{(["recommended", "available", "added"] as const).map(value => <button type="button" key={value} aria-current={view === value ? "page" : undefined} onClick={() => setView(value)}>{value === "recommended" ? "Recommended" : value === "available" ? "Available" : <>Added <span>{selectedCount}</span></>}</button>)}</nav><label className="catalogue-search"><Search size={15} aria-hidden="true" /><Input aria-label={`Search ${kind}`} placeholder={`Search ${kind}`} value={query} onChange={event => setQuery(event.target.value)} /></label>{kind === "skills" ? <SkillImport path={skillsPath} onImported={skill => { setPackageId(skill.id); setView("available"); setLibrary("private"); setAttempt(value => value + 1); }} /> : null}</div>
    {kind === "skills" ? <label className="catalogue-library">Library<select value={library} onChange={event => setLibrary(event.target.value)}><option value="all">All skills</option><option value="curated">Curated</option><option value="private">Private</option></select></label> : null}
    <ErrorMessage value={error} />{error ? <Button type="button" size="sm" variant="outline" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Try again</Button> : null}
    {!data && !error ? <Loading /> : data ? <div className="catalogue-list">{entries.length ? entries.map(item => <article className="catalogue-row" key={item.id}>
      <CatalogueIcon item={item} /><div className="catalogue-details"><h2>{kind === "skills" ? <button type="button" className="catalogue-preview-trigger" onClick={() => { const id = item.configuration.skillIds[0]; if (id) setPackageId(id); else setPreview(item); }}>{item.name}</button> : item.name}</h2><p>{item.description}</p><span className="catalogue-publisher">{item.publisher.name}</span>{item.readiness.state !== "ready" && item.readiness.reasons.length ? <p className="catalogue-readiness">{item.readiness.reasons.map(reason => reason.message).join(" ")}</p> : null}</div><div className="catalogue-actions">{action(item)}</div>
    </article>) : <div className="catalogue-empty"><p>{needle ? `No ${kind} match your search` : view === "added" ? `No ${kind} added` : `No ${view} ${kind}`}</p>{!needle && view !== "available" ? <Button type="button" size="sm" variant="outline" onClick={() => setView("available")}>Browse {kind}</Button> : null}</div>}</div> : null}
    {packageId ? <SkillPreview key={packageId} path={skillsPath} id={packageId} canReview={canReview} onReviewed={() => setAttempt(value => value + 1)} close={() => setPackageId(null)} /> : null}
    {preview?.source?.kind === "curated" && preview.source.slug ? <CuratedSkillPreview key={preview.source.slug} path={`${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/skills/curated`} slug={preview.source.slug} onInstalled={installed} close={() => setPreview(null)} /> : null}
    <Dialog open={Boolean(preview && preview.source?.kind !== "curated")} onOpenChange={open => { if (!open) setPreview(null); }}><DialogContent><DialogHeader><DialogTitle>{preview?.name}</DialogTitle><DialogDescription>{preview?.description}</DialogDescription></DialogHeader>{preview ? <><p className="text-xs text-muted-foreground">{preview.publisher.name}</p>{preview.readiness.reasons.map(reason => <p className="text-sm text-muted-foreground" key={reason.code}>{reason.message}</p>)}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setPreview(null)}>Close</Button>{action(preview)}</div></> : null}</DialogContent></Dialog>
  </section>;
}
