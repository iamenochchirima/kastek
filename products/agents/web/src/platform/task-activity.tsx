import { Link } from "react-router-dom";
import {EnquiryConfirmations} from "./enquiry-confirmations";
import { PiFileText as FileText, PiDownload as Download } from "react-icons/pi";
import "./management.css";
import { Button } from "@/components/ui/button";
import { TaskReview } from "./task-review";
import { ToolReviews } from "./tool-reviews";
import { BookingConfirmations } from "./booking-confirmations";
import type { Task } from "./api";

export function cleanupPending(task: Task): boolean {
  return Boolean(task.resources?.some(resource => resource.cleanupState !== "completed"));
}
export function TaskActivity({ task, onRefresh, readOnly = false }: { task: Task; onRefresh?: () => void; readOnly?: boolean }) {
  const resources = task.resources ?? [], artifacts = task.artifacts ?? [];
  const hasActivity = resources.length || artifacts.length || task.actions?.length;
  return <>{readOnly ? task.state === "waiting_review" || task.actions?.length || task.hasToolReviews || task.hasBookings || task.hasEnquiries ? <Button asChild variant="ghost" size="sm"><Link to={`/app/tasks/${encodeURIComponent(task.id)}`}>Open task</Link></Button> : null : <><EnquiryConfirmations key={`enquiry:${task.id}`} taskId={task.id} awaiting={task.state === "waiting_review"} available={Boolean(task.hasEnquiries)} onRefresh={onRefresh}/><BookingConfirmations key={`booking:${task.id}`} taskId={task.id} awaiting={task.state === "waiting_review" && Boolean(task.hasBookings)} available={Boolean(task.hasBookings)} onRefresh={onRefresh} /><ToolReviews key={task.id} taskId={task.id} awaiting={task.state === "waiting_review"} available={Boolean(task.hasToolReviews)} onRefresh={onRefresh} /></>}{hasActivity ? <div className="task-activity">
    {!readOnly && task.actions?.length ? <TaskReview actions={task.actions} onRefresh={onRefresh} /> : null}
    {resources.length ? <section aria-label="Analysis resources" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Analysis</h3><ul className="space-y-2">{resources.map(resource => <li key={resource.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"><span>{resource.profile === "python-analysis-v1" ? "Python analysis" : resource.profile}<span className="ml-2 text-xs text-muted-foreground">{resource.state.replaceAll("_", " ")}</span></span><span className="text-xs text-muted-foreground">{resource.cleanupState === "completed" ? "Resources cleaned" : resource.cleanupState === "active" ? "Compute active" : resource.cleanupState === "uncertain" ? "Cleanup outcome unknown" : `Cleanup ${resource.cleanupState.replaceAll("_", " ")}`}</span>{resource.errorCode ? <span className="basis-full text-xs text-muted-foreground">{resource.errorCode.replaceAll("_", " ").toLowerCase()}</span> : null}</li>)}</ul></section> : null}
    {onRefresh && (resources.some(resource => resource.cleanupState === "uncertain") || task.actions?.some(action => action.state === "uncertain")) ? <Button type="button" size="sm" variant="outline" onClick={onRefresh}>Refresh status</Button> : null}
    {artifacts.length ? <section aria-label="Task files" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Files</h3><ul className="space-y-2">{artifacts.map(artifact => <li key={artifact.id} className="task-file text-sm"><FileText className="size-5 shrink-0 text-muted-foreground" />{artifact.downloadPath.startsWith("/api/organizations/") ? <a href={artifact.downloadPath} className="min-w-0 flex-1 break-all font-medium hover:text-primary">{artifact.name || "Download file"}<Download aria-hidden="true" className="ml-2 inline size-3.5 text-muted-foreground" /></a> : <span className="break-all">{artifact.name || "File unavailable"}</span>}<span className="text-xs text-muted-foreground">{artifact.bytes < 1024 ? `${artifact.bytes} bytes` : `${Math.ceil(artifact.bytes / 1024)} KiB`}</span></li>)}</ul></section> : null}
  </div> : null}</>;
}
