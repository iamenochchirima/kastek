import { PlatformError } from "../../contracts/contracts";

/** A preview never starts unclassified tools or effects, including delegation. */
export function assertPrivatePreviewOperation(input:{kind:string;name:string},handoffFeedback=false):void {
  const allowed = input.kind === "model" && input.name === "model.generate" ||
    input.kind === "compaction" && input.name === "context.compact" ||
    input.kind === "tool" && ["knowledge.search", "knowledge.read", "tools.discover", "tools.load"].includes(input.name);
  if (!allowed || handoffFeedback) throw new PlatformError("PREVIEW_ACTION_UNAVAILABLE", 403, "This action is unavailable in a private preview");
}
