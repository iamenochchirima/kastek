import { App } from "@modelcontextprotocol/ext-apps";

type RecordValue = Record<string, unknown>;
type Review = { previewId: string; token: string; expiresAt: string; state: string; preview: RecordValue; mediaPreviews: RecordValue[] };
const META = "kasitek.co.za/contentReview";
const app = new App({ name: "Growth content review", version: "1.0.0" });
const root = document.querySelector<HTMLElement>("#review")!;
const status = document.querySelector<HTMLElement>("#status")!;
const approve = document.querySelector<HTMLButtonElement>("#approve")!;
const reject = document.querySelector<HTMLButtonElement>("#reject")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const checkStatus = document.querySelector<HTMLButtonElement>("#check-status")!;
let current: Review | undefined;
let busy = false;
let connected = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollCount = 0;
let approvedHere = false;
let deliveryState = "";
let actionBlock: "stale" | "access" | "confirmation" | "server" | undefined;
let notice: string | undefined;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
const titles: Record<string, string> = {
  "content.posts.publish": "Publish post", "content.posts.publish_batch": "Publish post",
  "content.posts.publish_batch.retry": "Retry publication", "content.jobs.retry": "Retry publication",
  "content.posts.schedule": "Schedule post", "content.posts.reschedule": "Reschedule post",
  "content.posts.unschedule": "Unschedule post", "content.jobs.cancel": "Cancel publication",
  "content.posts.delete": "Delete draft", "content.posts.delete_published": "Delete published post",
  "content.posts.update_published": "Update published post",
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value?: unknown, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = text(value);
  if (className) element.className = className;
  return element;
}
function section(title: string): HTMLElement {
  const block = node("section"); block.append(node("h2", title)); root.append(block); return block;
}
function field(parent: HTMLElement, label: string, value: unknown) {
  if (!text(value)) return;
  const line = node("div", undefined, "field"); line.append(node("span", label, "label"), node("span", value)); parent.append(line);
}
function copy(parent: HTMLElement, value: unknown) { parent.append(node("div", value, "copy")); }
function mediaList(values: RecordValue[], title: string) {
  if (!values.length) return;
  const list = node("ol", undefined, "media");
  for (const media of values) {
    const item = node("li");
    item.append(node("div", media.fileName || "Media", "media-name"));
    const visual = current?.mediaPreviews.find(value => value.assetId === media.assetId);
    let previewUrl: URL | undefined;
    try {
      const candidate = new URL(text(visual?.previewUrl));
      const allowedOrigin = document.querySelector<HTMLMetaElement>('meta[name="growth-media-origin"]')?.content;
      if (["http:", "https:"].includes(candidate.protocol) && !candidate.username && !candidate.password && candidate.origin === allowedOrigin) previewUrl = candidate;
    } catch { /* Unavailable previews remain explicit beside their immutable asset details. */ }
    if (previewUrl && ["IMAGE", "VIDEO"].includes(text(visual?.kind))) {
      const visualElement = visual?.kind === "VIDEO" ? node("video") : node("img");
      visualElement.className = "media-preview";
      visualElement.setAttribute("referrerpolicy", "no-referrer");
      if (visualElement instanceof HTMLVideoElement) { visualElement.controls = true; visualElement.preload = "metadata"; visualElement.playsInline = true; visualElement.setAttribute("aria-label", text(media.altText || media.fileName) || "Video preview"); }
      else visualElement.alt = text(media.altText || media.fileName) || "Image preview";
      visualElement.addEventListener("error", () => { visualElement.replaceWith(node("p", "Media preview unavailable", "warning")); }, { once: true });
      visualElement.src = previewUrl.href; item.append(visualElement);
    } else item.append(node("p", "Media preview unavailable", "muted"));
    const bytes = Number(media.byteSize);
    const size = bytes > 0 ? (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : "";
    const format = text(media.mimeType).split("/")[1]?.toUpperCase() || text(media.kind).toLowerCase();
    const dimensions = media.width && media.height ? `${media.width} × ${media.height}` : "";
    const duration = media.durationMs ? `${Number(media.durationMs) / 1000}s` : "";
    item.append(node("p", [format, size, dimensions, duration].filter(Boolean).join(" · "), "muted media-description"));
    field(item, "Alt text", media.altText);
    if (media.processingStatus && !["READY", "COMPLETED"].includes(text(media.processingStatus))) field(item, "Processing", text(media.processingStatus).toLowerCase());
    if (media.scanStatus && !["CLEAN", "PASSED", "NOT_REQUIRED"].includes(text(media.scanStatus))) field(item, "Scan", text(media.scanStatus).toLowerCase());
    list.append(item);
  }
  section(title).append(list);
}
function exactDetails(preview: RecordValue) {
  const disclosure = node("details", undefined, "exact-details"); disclosure.append(node("summary", "Exact details"));
  disclosure.append(node("pre", JSON.stringify(preview, null, 2), "copy")); root.append(disclosure);
}
function ready(): boolean { return record(current?.preview.validation).ready === true; }
function expired(): boolean { return !current || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now(); }
function controls() {
  const proposed = current?.state === "proposed";
  approve.disabled = !connected || busy || !!actionBlock || !proposed || !ready() || expired();
  reject.disabled = !connected || busy || !!actionBlock || !proposed || expired();
  checkStatus.disabled = !connected || busy || !current;
  const canRefresh = proposed && (!actionBlock || actionBlock === "confirmation" && expired());
  refresh.disabled = !connected || busy || !canRefresh;
  refresh.hidden = !canRefresh || !(expired() || !ready());
  if (current && expired() && proposed && !busy && !notice) status.textContent = "Preview expired";
}
function render(review: Review) {
  current = review; root.replaceChildren();
  const preview = review.preview;
  document.querySelector("#title")!.textContent = titles[text(preview.action)] || "Review content";
  const destructive = ["content.posts.delete", "content.posts.delete_published"].includes(text(preview.action));
  approve.classList.toggle("destructive", destructive);
  approve.textContent = destructive ? "Delete" : "Approve";
  if (preview.title) root.append(node("p", preview.title, "post-title"));
  if (destructive) root.append(node("p", preview.action === "content.posts.delete_published" ? "This removes the selected published content." : "This deletes the saved draft.", "warning"));
  if (preview.previousContent !== undefined) copy(section("Previous copy"), preview.previousContent);
  const variants = rows(preview.variants);
  const accounts = rows(preview.accounts);
  const targets = rows(preview.targets);
  const destinationName = (target: RecordValue) => {
    const account = accounts.find(value => target.accountId && value.id === target.accountId) ?? accounts.find(value => value.platform === target.platform);
    return [text(target.platform), text(account?.displayName), text(account?.handle)].filter(Boolean).join(" · ");
  };
  const contentGroups = new Map<string, string[]>();
  const actualTargets = targets.length ? targets : variants.length ? variants : [{ content: preview.content }];
  for (const target of actualTargets) {
    const content = text(target.content ?? variants.find(value => value.platform === target.platform)?.content ?? preview.content);
    const names = contentGroups.get(content) ?? [];
    const name = destinationName(target);
    if (name && !names.includes(name)) names.push(name);
    contentGroups.set(content, names);
  }
  const post = section(preview.previousContent !== undefined ? "Updated post" : "Post");
  for (const [content, names] of contentGroups) {
    const group = node("div", undefined, "post-copy");
    if (names.length) group.append(node("p", names.join("\n"), "destination-name"));
    copy(group, content); post.append(group);
  }
  if (!targets.length && accounts.length) {
    const destinations = section("Destinations");
    for (const account of accounts) destinations.append(node("p", [account.platform, account.displayName, account.handle].map(text).filter(Boolean).join(" · "), "destination-name"));
  } else if (!accounts.length) post.append(node("p", "No account selected", "muted"));
  mediaList(rows(preview.media), "Media"); mediaList(rows(preview.removedMedia), "Media to remove");
  if (preview.removePhoto === true) root.append(node("p", "Remove published photo", "warning"));
  const remotes = rows(preview.remoteMedia);
  if (remotes.length) { const block = section("Remote media"); for (const remote of remotes) { field(block, text(remote.platform), remote.url || remote.urlOmitted || (remote.invalidUrl ? "Invalid URL" : "Unavailable")); } }
  if (preview.scheduledFor || preview.requestedScheduledFor) {
    const block = section("Schedule");
    const time = text(preview.requestedScheduledFor || preview.scheduledFor); const timezone = text(preview.timezone) || "UTC";
    let localized = time;
    try { localized = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long", timeZone: timezone }).format(new Date(time)); } catch { /* Keep the exact stored timestamp if locale/timezone is unavailable. */ }
    field(block, "Timezone", timezone); field(block, "When", localized); field(block, "Exact time", time);
  }
  if (preview.tiktok) { const block = section("TikTok settings"); const settings = record(preview.tiktok); field(block, "Privacy", settings.privacyLevel); field(block, "Format", settings.mediaType); field(block, "Consent", JSON.stringify(settings.consent)); }
  const errors = rows(record(preview.validation).errors);
  if (errors.length) { const block = section("Needs attention"); const list = node("ul", undefined, "errors"); for (const error of errors) list.append(node("li", error.message || error.code)); block.append(list); }
  exactDetails(preview);
  status.textContent = ({ proposed: "Awaiting approval", approved: "Approved", executing: "Processing", succeeded: "Completed", rejected: "Rejected", expired: "Preview expired. Request a new preview.", failed: "Failed", uncertain: "Outcome needs checking" } as Record<string,string>)[review.state] || review.state;
  controls();
}
function accept(result: unknown): boolean {
  const value = record(result);
  const hidden = record(record(value._meta)[META]);
  if (typeof hidden.previewId !== "string" || typeof hidden.token !== "string" || typeof hidden.expiresAt !== "string" || typeof hidden.state !== "string" || !Object.keys(record(hidden.preview)).length) {
    actionBlock = "server"; stopPolling();
    status.textContent = "Preview unavailable"; approve.disabled = true; reject.disabled = true; return false;
  }
  if (!actionBlock) notice = undefined;
  if (current?.previewId !== hidden.previewId) { actionBlock = undefined; notice = undefined; approvedHere = false; pollCount = 0; stopPolling(); }
  render({ previewId: hidden.previewId, token: hidden.token, expiresAt: hidden.expiresAt, state: hidden.state, preview: record(hidden.preview), mediaPreviews: rows(hidden.mediaPreviews) });
  const structured = record(value.structuredContent);
  const delivery = record(hidden.delivery ?? structured.delivery);
  deliveryState = text(delivery.status).toUpperCase();
  const total = Number(delivery.targetCount);
  const published = Number(delivery.publishedCount);
  const confirmedPublished = ["SUCCEEDED", "PUBLISHED"].includes(deliveryState) && total > 0 && published === total && Number(delivery.unknownCount) === 0 && Number(delivery.failedCount) === 0;
  if (deliveryState) {
    const block = section("Publication status");
    const counts = [];
    if (Number.isFinite(published) && total > 0) counts.push(`${published} of ${total} published`);
    for (const [key, label] of [["processingCount", "processing"], ["failedCount", "failed"], ["unknownCount", "unknown"], ["blockedCount", "blocked"]] as const) {
      if (Number(delivery[key]) > 0) counts.push(`${delivery[key]} ${label}`);
    }
    block.append(node("p", counts.join(" · ") || text(delivery.status).replaceAll("_", " ").toLowerCase()));
    for (const target of rows(delivery.targets)) {
      if (target.errorMessage || target.errorCode) block.append(node("p", `${text(target.platform)} · ${text(target.errorMessage || target.errorCode)}`, "warning"));
    }
    if (delivery.errorMessage) block.append(node("p", delivery.errorMessage, "warning"));
  }
  if (Number(delivery.unknownCount) > 0 || deliveryState === "UNKNOWN") {
    deliveryState = "UNKNOWN"; status.textContent = "Outcome needs checking";
  } else if (confirmedPublished) status.textContent = "Published";
  else if (["PROCESSING", "QUEUED", "PENDING"].includes(deliveryState)) status.textContent = "Publication processing";
  else if (deliveryState) status.textContent = deliveryState.replaceAll("_", " ").toLowerCase();
  else if ((hidden.outcome ?? structured.outcome) === "publication_admitted" && hidden.state === "succeeded") status.textContent = "Publication accepted";
  if (notice) status.textContent = notice;
  return true;
}
function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; }
function scheduleStatus() {
  stopPolling();
  if (actionBlock || !approvedHere || !current || (!["approved", "executing"].includes(current.state) && !(current.state === "succeeded" && ["QUEUED", "PROCESSING", "PENDING"].includes(deliveryState))) || deliveryState === "UNKNOWN" || pollCount >= 12) return;
  pollTimer = setTimeout(() => { pollCount++; void invoke("status"); }, 1500);
}
async function invoke(decision: "approve" | "reject" | "status" | "refresh") {
  if (!current || busy || !connected) return;
  if (decision === "approve" && (actionBlock || !ready() || expired() || current.state !== "proposed")) return;
  if (decision === "reject" && (expired() || current.state !== "proposed")) return;
  busy = true; root.setAttribute("aria-busy", "true"); stopPolling(); controls();
  status.textContent = ({ approve: "Approving…", reject: "Rejecting…", status: "Checking status…", refresh: "Refreshing…" })[decision];
  const identity = current.previewId;
  try {
    const result = await app.callServerTool({ name: "content.actions.confirm", arguments: { previewId: identity, token: current.token, decision } });
    if (record(result).isError) {
      const code = text(record(record(result).structuredContent).code);
      if (code === "operation_review_conflict") { actionBlock = "stale"; notice = "Content changed. Request a new preview."; }
      else if (["operation_scope_denied", "operation_credential_revoked", "credential_revoked", "operation_actor_denied", "operation_review_denied"].includes(code)) { actionBlock = "access"; notice = "Access unavailable"; }
      else if (code === "content_confirmation_invalid") { actionBlock = "confirmation"; notice = current.state === "proposed" && expired() ? "Confirmation expired. Refresh preview." : "Confirmation unavailable. Request a new preview."; }
      else if (["operation_rate_limited", "rate_limited", "too_many_requests"].includes(code)) notice = "Too many requests. Try again shortly.";
      else { if (decision === "approve") actionBlock = "server"; notice = "Action unavailable. Check status."; }
      status.textContent = notice;
      return;
    }
    if (!accept(result)) { actionBlock = "server"; notice = "Preview unavailable. Request a new preview."; status.textContent = notice; return; }
    if (decision === "approve") approvedHere = true;
    if (decision === "refresh") { actionBlock = undefined; notice = undefined; approvedHere = false; pollCount = 0; if (current) render(current); }
  } catch {
    notice = decision === "approve" ? "Could not confirm outcome. Check status." : "Action unavailable. Try again."; status.textContent = notice;
    if (decision === "approve") { approvedHere = true; if (current?.previewId === identity) current.state = "uncertain"; }
  } finally { busy = false; root.setAttribute("aria-busy", "false"); controls(); scheduleStatus(); }
}
approve.addEventListener("click", () => void invoke("approve"));
reject.addEventListener("click", () => void invoke("reject"));
refresh.addEventListener("click", () => void invoke("refresh"));
checkStatus.addEventListener("click", () => void invoke("status"));
app.ontoolresult = result => { accept(result); };
function theme(context: RecordValue) { document.documentElement.dataset.theme = context.theme === "dark" ? "dark" : "light"; }
app.onhostcontextchanged = context => theme(context as RecordValue);
void app.connect().then(() => { connected = true; theme((app.getHostContext() ?? {}) as RecordValue); controls(); }).catch(() => { status.textContent = "Connection unavailable"; });
setInterval(controls, 1000);
window.addEventListener("pagehide", stopPolling);
