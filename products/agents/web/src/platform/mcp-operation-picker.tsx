import { useState } from "react";
import { Input } from "@/components/ui/input";
import type { RemoteOperation, RemoteTarget, RemoteToolCatalogue } from "./api";

type Category = RemoteTarget["kind"];
const labels: Record<Category, string> = { tool: "Tools", resource: "Resources", template: "Templates", prompt: "Prompts" };
export function remoteOperationLabel(operation: RemoteOperation) {
  const target = operation.remote?.target;
  return target?.kind === "resource" ? target.uri : target?.kind === "template" ? target.uriTemplate : target?.name ?? operation.providerOperation.replaceAll("_", " ");
}
/** Inventory-only rows explain incompatibility; only the candidate supplies selectable operation IDs. */
export function remotePickerOperations(candidate: RemoteOperation[], inventory?: RemoteToolCatalogue): RemoteOperation[] {
  const operations = [...candidate], seen = new Set(candidate.map(operation => operation.providerOperation));
  for (const tool of inventory?.tools ?? []) if (!seen.has(tool.name)) {
    operations.push({ providerOperation: tool.name, description: tool.description, compatible: tool.compatible, remote: { target: { kind: "tool", name: tool.name } }, diagnostics: tool.diagnostics?.length ? tool.diagnostics : [{ code: "MCP_TOOL_UNAVAILABLE", message: "This tool is unavailable for selection." }] });
    seen.add(tool.name);
  }
  for (const content of inventory?.contentOperations ?? []) if (!seen.has(content.name)) {
    const display = content.inventoryTarget;
    const target = content.target ?? (display?.kind === "template" ? { ...display, variableNames: [] } : display?.kind === "prompt" ? { ...display, arguments: [] } : display);
    operations.push({ providerOperation: content.name, description: content.description, compatible: content.compatible, ...(target ? { remote: { target } } : {}), diagnostics: content.diagnostics.length ? content.diagnostics : [{ code: "MCP_CONTENT_UNAVAILABLE", message: "This entry is unavailable for selection." }] });
    seen.add(content.name);
  }
  return operations;
}
export function templateSelectionsComplete(operations: RemoteOperation[], selected: string[], argumentsByOperation: Record<string, Record<string, string>>) {
  return selected.every(id => { const target = operations.find(operation => operation.providerOperation === id)?.remote?.target;
    return target?.kind !== "template" || target.variableNames.every(name => Boolean(argumentsByOperation[id]?.[name]?.trim())); });
}
export function McpOperationPicker({ operations, selectable, selected, change, templateArguments, changeArguments, disabled }: {
  operations: RemoteOperation[]; selectable: string[]; selected: string[]; change: (value: string[]) => void;
  templateArguments: Record<string, Record<string, string>>; changeArguments: (value: Record<string, Record<string, string>>) => void; disabled: boolean;
}) {
  const [category, setCategory] = useState<Category>("tool"), [query, setQuery] = useState("");
  const items = operations.filter(operation => (operation.remote?.target?.kind ?? "tool") === category);
  const visible = items.filter(operation => `${remoteOperationLabel(operation)} ${operation.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const label = labels[category];
  return <div className="space-y-3"><nav aria-label="Server capabilities" className="catalogue-views flex flex-wrap">{(Object.keys(labels) as Category[]).map(kind => <button type="button" key={kind} aria-current={category === kind ? "page" : undefined} onClick={() => { setCategory(kind); setQuery(""); }}>{labels[kind]}</button>)}</nav>
    <h3 className="text-sm font-medium">{label} · {items.length}</h3>
    {items.length ? <><Input aria-label={category === "tool" ? "Search server tools" : `Search server ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}`} value={query} onChange={event => setQuery(event.target.value)} />
      <fieldset className="max-h-72 space-y-3 overflow-y-auto"><legend className="mb-2 text-xs text-muted-foreground">Select {label.toLowerCase()} · {selected.length}/8</legend>{visible.length ? visible.map(operation => {
        const id = operation.providerOperation, target = operation.remote?.target, checked = selected.includes(id);
        return <div className="min-w-0 space-y-3 border-b border-border pb-3" key={id}><label className="flex min-w-0 items-start gap-3"><input className="mt-1 size-4 shrink-0 accent-primary" type="checkbox" checked={checked} disabled={disabled || operation.compatible === false || !selectable.includes(id) || !checked && selected.length >= 8} onChange={event => change(event.target.checked ? [...selected, id] : selected.filter(value => value !== id))} /><span className="min-w-0"><span className="block break-words text-sm font-medium">{remoteOperationLabel(operation)}</span><span className="mt-1 block break-words text-sm text-muted-foreground">{operation.description}</span></span></label>
          {operation.diagnostics?.map((diagnostic, index) => <p key={index} className="pl-7 text-xs text-muted-foreground">{diagnostic.message}</p>)}
          {target?.kind === "template" && checked ? <div className="space-y-3 pl-7"><p className="text-xs text-muted-foreground">Select the exact resource this agent can read. Enter a nonempty value for each field.</p>{target.variableNames.map(name => <label key={name} className="block space-y-1 text-sm">{name}<Input required maxLength={512} disabled={disabled} value={templateArguments[id]?.[name] ?? ""} onChange={event => changeArguments({ ...templateArguments, [id]: { ...templateArguments[id], [name]: event.target.value } })} /></label>)}</div> : null}
          {target?.kind === "prompt" ? <div className="space-y-1 pl-7 text-xs text-muted-foreground"><p>Each use requires approval of the exact prompt and arguments.</p>{target.arguments.map(argument => <p key={argument.name}>{argument.name}{argument.required ? " · Required" : " · Optional"}{argument.description ? ` · ${argument.description}` : ""}</p>)}</div> : null}
        </div>;
      }) : <p className="text-sm text-muted-foreground">No matching {label.toLowerCase()}.</p>}</fieldset></> : <p className="text-sm text-muted-foreground">This server returned no {label.toLowerCase()}.</p>}
  </div>;
}
