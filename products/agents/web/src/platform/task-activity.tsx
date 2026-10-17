import { Button } from "@/components/ui/button";
import { TaskReview } from "./task-review";
import type { Task } from "./api";

function connectedError(code: string): string {
  if (/AUTHENTICATION|CREDENTIAL/.test(code)) return "Connection authorization failed.";
  if (/RATE_LIMIT/.test(code)) return "Provider rate limit reached.";
  if (/TIMEOUT|DEADLINE/.test(code)) return "Read timed out.";
  if (/CANCEL/.test(code)) return "Read cancelled.";
  if (/RELEASE|CATALOG|SCHEMA/.test(code)) return "The selected tool version is unavailable.";
  if (/OUTCOME|UNCERTAIN/.test(code)) return "Read outcome unknown.";
  if (/SCOPE|DENIED|REVOKED/.test(code)) return "Access is no longer available.";
  return "Read could not be completed.";
}
export function cleanupPending(task: Task): boolean {
  return Boolean(task.resources?.some(resource => resource.cleanupState !== "completed"));
}
export function TaskActivity({ task, onRefresh }: { task: Task; onRefresh?: () => void }) {
  const children = task.children ?? [], resources = task.resources ?? [], artifacts = task.artifacts ?? [];
  const connected = task.operations?.filter(operation => operation.transport === "native_http" || operation.transport === "mcp_http") ?? [];
  if (!connected.length && !children.length && !resources.length && !artifacts.length && !task.actions?.length) return null;
  return <div className="space-y-4 border-t border-border pt-4">
    {connected.length ? <section aria-label="Connected tools" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Connected tools</h3><ul className="space-y-2">{connected.map((operation, index) => <li key={operation.operationId ?? index} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"><span>{(operation.providerOperation ?? "Read").replaceAll("_", " ")}<span className="ml-2 text-xs text-muted-foreground">{operation.transport === "mcp_http" ? "MCP" : "API"}</span></span><span className="text-xs text-muted-foreground">{operation.state === "uncertain" ? "Outcome unknown" : operation.state.replaceAll("_", " ")}</span>{operation.errorCode ? <span className="basis-full text-xs text-muted-foreground">{connectedError(operation.errorCode)}</span> : null}</li>)}</ul></section> : null}
    {task.actions?.length ? <TaskReview actions={task.actions} onRefresh={onRefresh} /> : null}
    {children.length ? <section aria-label="Specialist tasks" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Specialists</h3><div className="divide-y divide-border">{children.map(child => <details key={child.id} className="py-2 text-sm"><summary className="cursor-pointer"><span className="break-words font-medium">{child.agentName}</span><span className="ml-2 text-xs text-muted-foreground">Version {child.versionNumber} · {child.state.replaceAll("_", " ")}</span></summary><div className="mt-3 space-y-2">{child.output ? <p className="whitespace-pre-wrap break-words leading-6">{child.output}</p> : null}{child.outputAvailability === "unavailable" ? <p className="text-xs text-muted-foreground">This response is no longer available.</p> : null}{child.errorCode ? <p className="text-xs text-muted-foreground">{child.errorCode.replaceAll("_", " ").toLowerCase()}</p> : null}<code className="block break-all text-xs text-muted-foreground">{child.id}</code></div></details>)}</div></section> : null}
    {resources.length ? <section aria-label="Analysis resources" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Analysis</h3><ul className="space-y-2">{resources.map(resource => <li key={resource.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"><span>{resource.profile === "python-analysis-v1" ? "Python analysis" : resource.profile}<span className="ml-2 text-xs text-muted-foreground">{resource.state.replaceAll("_", " ")}</span></span><span className="text-xs text-muted-foreground">{resource.cleanupState === "completed" ? "Resources cleaned" : resource.cleanupState === "active" ? "Compute active" : resource.cleanupState === "uncertain" ? "Cleanup outcome unknown" : `Cleanup ${resource.cleanupState.replaceAll("_", " ")}`}</span>{resource.errorCode ? <span className="basis-full text-xs text-muted-foreground">{resource.errorCode.replaceAll("_", " ").toLowerCase()}</span> : null}</li>)}</ul></section> : null}
    {onRefresh && (resources.some(resource => resource.cleanupState === "uncertain") || task.actions?.some(action => action.state === "uncertain")) ? <Button type="button" size="sm" variant="outline" onClick={onRefresh}>Refresh status</Button> : null}
    {artifacts.length ? <section aria-label="Task files" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Files</h3><ul className="space-y-2">{artifacts.map(artifact => <li key={artifact.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">{artifact.downloadPath.startsWith("/api/organizations/") ? <a href={artifact.downloadPath} className="min-w-0 break-all underline underline-offset-4">{artifact.name || "Download file"}</a> : <span className="break-all">{artifact.name || "File unavailable"}</span>}<span className="text-xs text-muted-foreground">{artifact.bytes < 1024 ? `${artifact.bytes} bytes` : `${Math.ceil(artifact.bytes / 1024)} KiB`}</span></li>)}</ul></section> : null}
  </div>;
}
