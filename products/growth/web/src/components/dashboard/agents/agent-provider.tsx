import { toast } from "sonner";
import { useLocation } from "react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { growthAgents, GrowthAgentRequestError, isActiveTask, type GrowthAgentBootstrap, type GrowthAgentContext, type GrowthAgentConversation, type GrowthAgentFeatureId, type GrowthAgentMessage, type GrowthAgentReview, type GrowthAgentTask, type GrowthAgentEvent } from "@/lib/growth-agents";

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const failure = (error: unknown) => error instanceof Error ? error.message : "Unable to load this work.";
function read(key: string) { try { return window.localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string | null) { try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* Chat remains usable when storage is blocked. */ } }
function merge<T extends { id: string }>(previous: T[], next: T[]) {
  const values = new Map(previous.map((item) => [item.id, item]));
  next.forEach((item) => values.set(item.id, item));
  return [...values.values()];
}

type PendingTurn = { conversationId: string; requestId: string; text: string; taskId?: string };
type AssistantState = {
  scopeKey: string; businessName: string; bootstrap: GrowthAgentBootstrap | null;
  panelOpen: boolean; loading: boolean; sending: boolean; continuingTaskId: string | null; error: string | null; reconnecting: boolean;
  conversation: GrowthAgentConversation | null; messages: GrowthAgentMessage[]; tasks: GrowthAgentTask[];
  reviews: GrowthAgentReview[]; events: GrowthAgentEvent[]; hasOlder: boolean; draft: string; unconfirmed: boolean;
  setDraft: (value: string) => void; closePanel: () => void; setPanelOpen: (open: boolean) => void;
  ensureBootstrap: (refresh?: boolean) => Promise<GrowthAgentBootstrap>;
  openGeneral: () => Promise<void>; start: (featureId: GrowthAgentFeatureId, context?: GrowthAgentContext | null, initialDraft?: string) => Promise<string | null>;
  openConversation: (conversationId: string, panel?: boolean, focusTaskId?: string) => Promise<void>;
  attachContext: (context: GrowthAgentContext | null) => Promise<string | null>;
  send: () => Promise<void>; refresh: () => Promise<void>; older: () => Promise<void>;
  cancel: (taskId: string) => Promise<void>; continueTask: (taskId: string) => Promise<void>; setError: (message: string | null) => void;
};
const AgentContext = createContext<AssistantState | null>(null);

export function GrowthAgentProvider({ children, userId, businessId, businessName }: { children: ReactNode; userId: string; businessId: string; businessName: string }) {
  const { pathname } = useLocation();
  const scopeKey = `${encodeURIComponent(userId)}:${encodeURIComponent(businessId)}`;
  const storagePrefix = `kasitek:growth-agents:${scopeKey}`;
  const [bootstrap, setBootstrap] = useState<GrowthAgentBootstrap | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [continuingTaskId, setContinuingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [conversation, setConversation] = useState<GrowthAgentConversation | null>(null);
  const [messages, setMessages] = useState<GrowthAgentMessage[]>([]);
  const [tasks, setTasks] = useState<GrowthAgentTask[]>([]);
  const [reviews, setReviews] = useState<GrowthAgentReview[]>([]);
  const [events, setEvents] = useState<GrowthAgentEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, updateDraft] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const selection = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const bootstrapRequest = useRef<Promise<GrowthAgentBootstrap> | null>(null);
  const conversationRef = useRef<GrowthAgentConversation | null>(null);
  const pendingTurn = useRef<PendingTurn | null>(null);
  const pendingContinuation = useRef<{ taskId: string; requestId: string } | null>(null);
  const sendingRef = useRef(false);
  const eventCursors = useRef(new Map<string, string>());
  const focusedTask = useRef<string | undefined>(undefined);
  const reviewCache = useRef(new Map<string, { revision: string; reviews: GrowthAgentReview[] }>());
  const createRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const pendingStart = useRef<{ featureId: GrowthAgentFeatureId; context: GrowthAgentContext | null; initialDraft: string } | null>(null);

  const run = useCallback(async <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const current = epoch.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted || epoch.current !== current) throw new DOMException("Scope changed", "AbortError");
      return value;
    } finally { controllers.current.delete(controller); }
  }, []);

  useEffect(() => {
    const abort = () => { epoch.current += 1; controllers.current.forEach((controller) => controller.abort()); controllers.current.clear(); };
    const changing = () => { abort(); setBlocked(true); setPanelOpen(false); setConversation(null); conversationRef.current = null; setMessages([]); setTasks([]); setReviews([]); updateDraft(""); pendingTurn.current = null; };
    const failed = () => { setBlocked(false); setError("Unable to switch business. Try again."); };
    window.addEventListener("kasitek:business-changing", changing);
    window.addEventListener("kasitek:business-change-failed", failed);
    return () => { abort(); window.removeEventListener("kasitek:business-changing", changing); window.removeEventListener("kasitek:business-change-failed", failed); };
  }, []);

  const ensureBootstrap = useCallback(async (refresh = false) => {
    if (bootstrap && !refresh) return bootstrap;
    if (!bootstrapRequest.current) bootstrapRequest.current = run((signal) => growthAgents.bootstrap(signal)).then((value) => {
      if (value.scope.businessId !== businessId || value.scope.userId !== userId) throw new GrowthAgentRequestError("Your business changed. Refresh to continue.", 409, "business_scope_changed");
      setBootstrap(value); return value;
    }).finally(() => { bootstrapRequest.current = null; });
    return bootstrapRequest.current;
  }, [bootstrap, run, businessId, userId]);

  const setupState = bootstrap?.setup?.state;
  useEffect(() => {
    if (blocked || !["pending", "running"].includes(setupState ?? "")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const value = await run((signal) => growthAgents.bootstrap(signal));
        if (stopped || value.scope.businessId !== businessId || value.scope.userId !== userId) return;
        setBootstrap(value);
        if (!["pending", "running"].includes(value.setup?.state ?? "")) return;
      } catch (cause) {
        if (stopped || aborted(cause) || cause instanceof GrowthAgentRequestError && [401, 403].includes(cause.status)) return;
      }
      if (!stopped && attempts < 30) timer = setTimeout(() => { void poll(); }, Math.min(10000, 2000 + attempts * 500));
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [setupState, blocked, run, businessId, userId]);

  const applyConversation = useCallback((value: GrowthAgentConversation) => {
    conversationRef.current = value; setConversation(value);
    updateDraft(read(`${storagePrefix}:draft:${value.id}`) ?? "");
    let pending: PendingTurn | null = null;
    try { pending = JSON.parse(read(`${storagePrefix}:pending:${value.id}`) ?? "null") as PendingTurn | null; } catch { /* Invalid local preferences are ignored. */ }
    if (!pending || pending.conversationId !== value.id || typeof pending.text !== "string" || typeof pending.requestId !== "string" || pending.taskId !== undefined && typeof pending.taskId !== "string") pending = null;
    pendingTurn.current = pending;
    setUnconfirmed(Boolean(pending));
    if (pending) updateDraft(pending.text);
    if (value.featureId === "assistant") save(`${storagePrefix}:general`, value.id);
  }, [storagePrefix]);

  const openConversation = useCallback(async (conversationId: string, panel = true, focusTaskId?: string) => {
    pendingStart.current = null; focusedTask.current = focusTaskId;
    const current = ++selection.current;
    setPanelOpen(panel); setLoading(true); setError(null); setReconnecting(false);
    setConversation(null); conversationRef.current = null; setMessages([]); setTasks([]); setReviews([]); setEvents([]); updateDraft("");
    try {
      await ensureBootstrap();
      const [detail, work, focus] = await run((signal) => Promise.all([growthAgents.conversation(conversationId, undefined, signal), growthAgents.tasks({ conversationId, limit: 50 }, signal), focusTaskId ? growthAgents.task(focusTaskId, signal) : Promise.resolve(null)]));
      if (selection.current !== current) return;
      applyConversation(detail.conversation); setMessages(detail.messages); setCursor(detail.nextCursor); setTasks(merge(work.tasks, focus?.task.conversationId === conversationId ? [focus.task] : []).filter((task) => task.conversationId === conversationId));
      setRevision((value) => value + 1);
    } catch (cause) { if (!aborted(cause) && selection.current === current) setError(failure(cause)); }
    finally { if (selection.current === current) setLoading(false); }
  }, [ensureBootstrap, run, applyConversation]);

  const start = useCallback(async (featureId: GrowthAgentFeatureId, context: GrowthAgentContext | null = null, initialDraft = "") => {
    if (sendingRef.current) return null;
    pendingStart.current = { featureId, context, initialDraft };
    sendingRef.current = true; focusedTask.current = undefined; setPanelOpen(true); setLoading(true); setError(null);
    setConversation(null); conversationRef.current = null; setMessages([]); setTasks([]); setReviews([]); setEvents([]); updateDraft(""); pendingTurn.current = null; setUnconfirmed(false);
    const current = ++selection.current;
    try {
      const home = await ensureBootstrap();
      const feature = home.features.find((item) => item.id === featureId);
      if (!feature?.ready) throw new Error(feature?.reasons[0]?.message || "This agent is not available.");
      const fingerprint = JSON.stringify({ featureId, context });
      if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: crypto.randomUUID() };
      const response = await run((signal) => growthAgents.createConversation({ requestId: createRequest.current!.id, featureId, context }, signal));
      if (selection.current !== current) return null;
      createRequest.current = null; pendingStart.current = null; applyConversation(response.conversation); if (initialDraft) { updateDraft(initialDraft); save(`${storagePrefix}:draft:${response.conversation.id}`, initialDraft); } setMessages([]); setTasks([]); setReviews([]); setEvents([]); setCursor(null); setRevision((value) => value + 1);
      return response.conversation.id;
    } catch (cause) { if (!aborted(cause) && selection.current === current) setError(failure(cause)); return null; }
    finally { sendingRef.current = false; if (selection.current === current) setLoading(false); }
  }, [ensureBootstrap, run, applyConversation, storagePrefix]);

  const openGeneral = useCallback(async () => {
    if (pendingStart.current) { const pending = pendingStart.current; await start(pending.featureId, pending.context, pending.initialDraft); return; }
    if (conversationRef.current?.featureId === "assistant") { await openConversation(conversationRef.current.id); return; }
    setPanelOpen(true); setLoading(true); setError(null);
    try {
      const home = await ensureBootstrap();
      const assistant = home.features.find((item) => item.id === "assistant");
      if (!assistant?.ready) throw new Error(assistant?.reasons[0]?.message || "This agent is not available.");
      const saved = read(`${storagePrefix}:general`);
      if (saved) {
        try {
          const existing = await run((signal) => growthAgents.conversation(saved, undefined, signal));
          if (existing.conversation.featureId === "assistant") { await openConversation(existing.conversation.id); return; }
        } catch (cause) {
          if (aborted(cause)) return;
          if (!(cause instanceof GrowthAgentRequestError) || ![403, 404].includes(cause.status)) throw cause;
        }
        save(`${storagePrefix}:general`, null);
      }
      const recent = await run((signal) => growthAgents.conversations({ featureId: "assistant", limit: 1 }, signal));
      if (recent.conversations[0]) await openConversation(recent.conversations[0].id);
      else await start("assistant");
    } catch (cause) { if (!aborted(cause)) setError(failure(cause)); }
    finally { setLoading(false); }
  }, [ensureBootstrap, openConversation, run, start, storagePrefix]);

  const refresh = useCallback(async () => {
    const selected = conversationRef.current;
    if (!selected) return;
    const current = selection.current;
    const [detail, work] = await run((signal) => Promise.all([growthAgents.conversation(selected.id, undefined, signal), growthAgents.tasks({ conversationId: selected.id, limit: 50 }, signal)]));
    if (selection.current !== current) return;
    conversationRef.current = detail.conversation; setConversation(detail.conversation);
    setMessages((previous) => merge(previous, detail.messages).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    setTasks(work.tasks.filter((task) => task.conversationId === selected.id));
    work.tasks.forEach((task) => reviewCache.current.delete(task.id));
    setRevision((value) => value + 1);
  }, [run]);

  const setDraft = useCallback((value: string) => {
    if (pendingTurn.current) return;
    updateDraft(value);
    const selected = conversationRef.current;
    if (selected) save(`${storagePrefix}:draft:${selected.id}`, value || null);
  }, [storagePrefix]);

  const send = useCallback(async () => {
    const selected = conversationRef.current;
    if (!selected || sendingRef.current || (!draft.trim() && !pendingTurn.current)) return;
    sendingRef.current = true; setSending(true); setError(null);
    const current = selection.current;
    const active = tasks.find(isActiveTask);
    if (!pendingTurn.current && active && (!active.canSteer || active.state === "cancel_requested")) { sendingRef.current = false; setSending(false); setError("This task cannot accept instructions right now."); return; }
    const turn = pendingTurn.current ?? { conversationId: selected.id, requestId: crypto.randomUUID(), text: draft.trim(), ...(active ? { taskId: active.id } : {}) };
    pendingTurn.current = turn; save(`${storagePrefix}:pending:${selected.id}`, JSON.stringify(turn));
    let acceptedConfirmed = false;
    try {
      const accepted = await run<{ task: GrowthAgentTask; replayed: boolean } | { accepted: true }>((signal) => turn.taskId ? growthAgents.instruct(turn.taskId, turn.text, turn.requestId, signal) : growthAgents.send(selected.id, turn.text, turn.requestId, signal));
      if (selection.current !== current) return;
      acceptedConfirmed = true; pendingTurn.current = null; setUnconfirmed(false); save(`${storagePrefix}:pending:${selected.id}`, null);
      updateDraft(""); save(`${storagePrefix}:draft:${selected.id}`, null);
      if ("task" in accepted) setTasks((previous) => merge(previous, [accepted.task]));
      else toast.success("Instructions queued");
      await refresh();
    } catch (cause) {
      if (!aborted(cause) && selection.current === current) {
        if (acceptedConfirmed) { setReconnecting(true); setError("Message accepted. Reconnect to check its progress."); return; }
        const definitive = cause instanceof GrowthAgentRequestError && [400, 401, 403, 404, 413, 422, ...(turn.taskId ? [409] : [])].includes(cause.status);
        if (definitive) { pendingTurn.current = null; setUnconfirmed(false); save(`${storagePrefix}:pending:${selected.id}`, null); setError(failure(cause)); }
        else { setUnconfirmed(true); setError("Delivery wasn't confirmed. Retry this message to check the original request."); }
      }
    } finally { sendingRef.current = false; if (selection.current === current) setSending(false); }
  }, [draft, refresh, run, storagePrefix, tasks]);

  const attachContext = useCallback(async (context: GrowthAgentContext | null) => {
    const selected = conversationRef.current;
    if (!selected || sendingRef.current) return null;
    setLoading(true); setError(null);
    try {
      const response = await run((signal) => growthAgents.context(selected.id, context, crypto.randomUUID(), signal));
      await openConversation(response.conversation.id, panelOpen);
      return response.conversation.id;
    } catch (cause) { if (!aborted(cause)) setError(failure(cause)); return null; }
    finally { setLoading(false); }
  }, [openConversation, panelOpen, run]);

  const older = useCallback(async () => {
    const selected = conversationRef.current;
    if (!selected || !cursor) return;
    const current = selection.current;
    try {
      const detail = await run((signal) => growthAgents.conversation(selected.id, cursor, signal));
      if (selection.current !== current) return;
      setMessages((previous) => merge(detail.messages, previous)); setCursor(detail.nextCursor);
    } catch (cause) { if (!aborted(cause)) setError(failure(cause)); }
  }, [cursor, run]);

  const cancel = useCallback(async (taskId: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(null);
    const current = selection.current;
    try {
      const result = await run((signal) => growthAgents.cancel(taskId, crypto.randomUUID(), signal));
      if (current !== selection.current) return;
      setTasks((previous) => merge(previous, [result.task])); setRevision((value) => value + 1);
    } catch (cause) { if (!aborted(cause) && current === selection.current) setError(failure(cause)); }
    finally { sendingRef.current = false; if (current === selection.current) setSending(false); }
  }, [run]);

  const continueTask = useCallback(async (taskId: string) => {
    if (sendingRef.current) return;
    const selected = conversationRef.current;
    if (!selected) return;
    const storageKey = `${storagePrefix}:continue:${selected.id}:${taskId}`;
    if (pendingContinuation.current?.taskId !== taskId) {
      pendingContinuation.current = { taskId, requestId: read(storageKey) || crypto.randomUUID() };
    }
    const continuation = pendingContinuation.current;
    save(storageKey, continuation.requestId);
    sendingRef.current = true; setSending(true); setContinuingTaskId(taskId); setError(null);
    const current = selection.current;
    try {
      const result = await run((signal) => growthAgents.continue(taskId, continuation.requestId, signal));
      if (current !== selection.current) return;
      if (result.task.conversationId !== selected.id) throw new Error("The continued task belongs to another conversation.");
      focusedTask.current = result.task.id;
      pendingContinuation.current = null; save(storageKey, null);
      setTasks(previous => merge(previous.map(task => task.id === taskId ? { ...task, canContinue: false } : task), [result.task]));
      setRevision(value => value + 1);
    } catch (cause) {
      if (!aborted(cause) && current === selection.current) {
        if (cause instanceof GrowthAgentRequestError && [400, 401, 403, 404, 409, 422].includes(cause.status)) {
          pendingContinuation.current = null; save(storageKey, null);
        }
        setError(failure(cause));
      }
    } finally {
      sendingRef.current = false;
      setSending(false); setContinuingTaskId(null);
    }
  }, [run, storagePrefix]);

  const activeId = conversation?.id;
  const observed = panelOpen || pathname.startsWith("/agents/conversations/");
  useEffect(() => {
    if (!activeId || !observed || blocked) return;
    const controller = new AbortController();
    const activeControllers = controllers.current;
    activeControllers.add(controller);
    const current = selection.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async () => {
      if (controller.signal.aborted || current !== selection.current) return;
      if (document.visibilityState === "hidden") { timer = setTimeout(poll, 4000); return; }
      try {
        const work = await growthAgents.tasks({ conversationId: activeId, limit: 50 }, controller.signal);
        const scopedTasks = work.tasks.filter((task) => task.conversationId === activeId);
        if (focusedTask.current && !scopedTasks.some((task) => task.id === focusedTask.current)) { const focus = await growthAgents.task(focusedTask.current, controller.signal); if (focus.task.conversationId === activeId) scopedTasks.push(focus.task); }
        const reviewTasks = scopedTasks.filter((task) => task.state === "waiting_review" || task.reviewIds?.length);
        const reviewsResponse = await Promise.all(reviewTasks.map(async (task) => {
          const cached = reviewCache.current.get(task.id);
          if (cached?.revision === task.updatedAt) return { reviews: cached.reviews };
          const response = await growthAgents.reviews(task.id, controller.signal);
          if (!controller.signal.aborted && current === selection.current) reviewCache.current.set(task.id, { revision: task.updatedAt, reviews: response.reviews });
          return response;
        }));
        const pending = scopedTasks.filter(isActiveTask);
        const activity = await Promise.all(pending.map((task) => growthAgents.events(task.id, eventCursors.current.get(task.id), controller.signal)));
        const detail = await growthAgents.conversation(activeId, undefined, controller.signal);
        if (controller.signal.aborted || current !== selection.current) return;
        activity.forEach((page, index) => { if (page.nextCursor) eventCursors.current.set(pending[index].id, page.nextCursor); });
        setEvents((previous) => merge(previous, activity.flatMap((page) => page.events)).slice(-100));
        setTasks(scopedTasks); setReviews(reviewsResponse.flatMap((page) => page.reviews));
        conversationRef.current = detail.conversation; setConversation(detail.conversation);
        setMessages((previous) => merge(previous, detail.messages).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        setReconnecting(false); failures = 0;
        if (pending.length) timer = setTimeout(poll, 3000);
      } catch (cause) {
        if (controller.signal.aborted || current !== selection.current) return;
        if (cause instanceof GrowthAgentRequestError && [401, 403, 404].includes(cause.status)) {
          setMessages([]); setTasks([]); setReviews([]); setError(failure(cause)); return;
        }
        failures += 1; setReconnecting(true);
        if (failures < 5) timer = setTimeout(poll, Math.min(15000, failures * 3000));
        else setError("Connection lost. Reconnect to check this work.");
      }
    };
    void poll();
    return () => { controller.abort(); activeControllers.delete(controller); if (timer) clearTimeout(timer); };
  }, [activeId, observed, blocked, revision]);

  const closePanel = useCallback(() => {
    selection.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    bootstrapRequest.current = null;
    setPanelOpen(false); setLoading(false); setSending(false); sendingRef.current = false;
    if (pendingTurn.current) { setUnconfirmed(true); setError("Delivery wasn't confirmed. Retry this message to check the original request."); }
  }, []);
  const changePanel = useCallback((open: boolean) => { if (open) setPanelOpen(true); else closePanel(); }, [closePanel]);
  const value = useMemo<AssistantState>(() => ({ scopeKey, businessName, bootstrap, panelOpen, loading, sending, continuingTaskId, error, reconnecting,
    conversation, messages, tasks, reviews, events, hasOlder: Boolean(cursor), draft, unconfirmed, setDraft,
    closePanel, setPanelOpen: changePanel, ensureBootstrap, openGeneral, start, openConversation,
    attachContext, send, refresh, older, cancel, continueTask, setError,
  }), [scopeKey, businessName, bootstrap, panelOpen, loading, sending, continuingTaskId, error, reconnecting, conversation, messages, tasks, reviews, events, cursor, draft, unconfirmed, setDraft, ensureBootstrap, openGeneral, start, openConversation, attachContext, send, refresh, older, cancel, continueTask, closePanel, changePanel]);
  return <AgentContext.Provider value={value}>{blocked ? <div className="flex min-h-[100dvh] items-center justify-center text-sm text-muted-foreground" role="status">Switching business…</div> : children}</AgentContext.Provider>;
}

export function useGrowthAgents() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("Growth agents require their workspace provider.");
  return context;
}
