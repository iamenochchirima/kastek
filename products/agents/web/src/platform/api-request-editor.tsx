import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Field = { id: string; name: string; location: "path" | "query" | "header" | "body"; type: "string" | "integer" | "number" | "boolean"; required: boolean };
export type RequestDraft = { title: string; method: string; path: string; authentication: "none" | "bearer" | "basic" | "header" | "query"; keyName: string; fields: Field[] };
export const initialRequestDraft = (): RequestDraft => ({ title: "", method: "GET", path: "/", authentication: "none", keyName: "", fields: [] });
export function requestTemplate(draft: RequestDraft) {
  const names = new Set<string>();
  for (const field of draft.fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(field.name) || ["__proto__", "constructor", "prototype"].includes(field.name)) throw new Error("Give every parameter a valid name.");
    const key = `${field.location}:${field.name}`;
    if (names.has(key)) throw new Error("Parameter names must be unique within each location.");
    names.add(key);
  }
  if (["GET", "HEAD"].includes(draft.method) && draft.fields.some(field => field.location === "body")) throw new Error("Choose a method that supports a request body.");
  if (["header", "query"].includes(draft.authentication) && !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(draft.keyName)) throw new Error("Enter the API key's parameter name.");
  const body = draft.fields.filter(field => field.location === "body");
  const securityScheme = draft.authentication === "none" ? undefined : draft.authentication === "bearer" || draft.authentication === "basic" ? { type: "http", scheme: draft.authentication } : { type: "apiKey", in: draft.authentication, name: draft.keyName };
  return { title: draft.title.trim(), method: draft.method, path: draft.path,
    parameters: draft.fields.filter(field => field.location !== "body").map(field => ({ name: field.name, in: field.location, required: field.location === "path" || field.required, schema: { type: field.type } })),
    ...(body.length ? { requestBody: { required: body.some(field => field.required), contentType: "application/json", schema: { type: "object", properties: Object.fromEntries(body.map(field => [field.name, { type: field.type }])), required: body.filter(field => field.required).map(field => field.name), additionalProperties: false } } } : {}),
    ...(securityScheme ? { securityScheme } : {}) };
}
const selectClass = "w-full rounded-md border bg-background p-2";
export function ApiRequestEditor({ value, change, disabled }: { value: RequestDraft; change(value: RequestDraft): void; disabled: boolean }) {
  const update = (patch: Partial<RequestDraft>) => change({ ...value, ...patch });
  const field = (id: string, patch: Partial<Field>) => update({ fields: value.fields.map(item => item.id === id ? { ...item, ...patch } : item) });
  return <fieldset disabled={disabled} className="min-w-0 space-y-4"><legend className="sr-only">Request definition</legend>
    <label className="block space-y-2 text-sm">Action name<Input required maxLength={120} value={value.title} onChange={event => update({ title: event.target.value })} placeholder="Find available appointments" /></label>
    <div className="grid gap-3 sm:grid-cols-[8rem_1fr]"><label className="block space-y-2 text-sm">Method<select aria-label="Method" className={selectClass} value={value.method} onChange={event => update({ method: event.target.value })}>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(method => <option key={method}>{method}</option>)}</select></label><label className="block space-y-2 text-sm">Request path<Input required maxLength={2048} value={value.path} onChange={event => update({ path: event.target.value })} placeholder="/appointments/{id}" /></label></div>
    <label className="block space-y-2 text-sm">Authentication<select aria-label="Authentication" className={selectClass} value={value.authentication} onChange={event => update({ authentication: event.target.value as RequestDraft["authentication"] })}><option value="none">None</option><option value="bearer">Bearer token</option><option value="basic">Username and password</option><option value="header">API key in header</option><option value="query">API key in query</option></select></label>
    {["header", "query"].includes(value.authentication) ? <label className="block space-y-2 text-sm">API key parameter name<Input required maxLength={128} value={value.keyName} placeholder="X-API-Key" onChange={event => update({ keyName: event.target.value })} /></label> : null}
    <p className="text-xs text-muted-foreground">Enter credentials after preview. Parameters describe what the agent can supply; the server URL stays fixed.</p>
    {value.fields.map((item, index) => <fieldset key={item.id} className="min-w-0 space-y-3 rounded-md border p-3"><legend className="px-1 text-sm">Parameter {index + 1}</legend><label className="block space-y-2 text-sm">Parameter name<Input required value={item.name} maxLength={128} onChange={event => field(item.id, { name: event.target.value })} /></label><div className="grid grid-cols-2 gap-3"><label className="block space-y-2 text-sm">Location<select aria-label="Location" className={selectClass} value={item.location} onChange={event => field(item.id, { location: event.target.value as Field["location"] })}><option value="query">Query</option><option value="path">Path</option><option value="header">Header</option><option value="body">JSON body</option></select></label><label className="block space-y-2 text-sm">Value type<select aria-label="Value type" className={selectClass} value={item.type} onChange={event => field(item.id, { type: event.target.value as Field["type"] })}>{["string", "integer", "number", "boolean"].map(type => <option key={type}>{type}</option>)}</select></label></div><div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.location === "path" || item.required} disabled={item.location === "path"} onChange={event => field(item.id, { required: event.target.checked })} />Required</label><Button type="button" size="sm" variant="ghost" onClick={() => update({ fields: value.fields.filter(entry => entry.id !== item.id) })}>Remove parameter {index + 1}</Button></div></fieldset>)}
    <Button type="button" size="sm" variant="outline" disabled={disabled || value.fields.length >= 50} onClick={() => update({ fields: [...value.fields, { id: crypto.randomUUID(), name: "", location: "query", type: "string", required: false }] })}>Add parameter</Button>
  </fieldset>;
}
