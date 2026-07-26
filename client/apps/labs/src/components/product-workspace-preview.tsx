"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Bell,
  Bot,
  Cable,
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronDown,
  CreditCard,
  Facebook,
  FileText,
  Grid2x2,
  Inbox,
  Instagram,
  LayoutGrid,
  Linkedin,
  Mail,
  MessageCircle,
  MoreHorizontal,
  MousePointer2,
  PhoneCall,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  Users,
  Wand2,
} from "lucide-react";

type DemoKind = "inbox" | "content";
type InboxStep =
  | "overview"
  | "open-inbox"
  | "all"
  | "whatsapp"
  | "conversation"
  | "reply"
  | "sent"
  | "booked";
type ContentStep =
  | "overview"
  | "open-content"
  | "content-home"
  | "new-draft"
  | "prompt"
  | "generate"
  | "variants"
  | "linkedin"
  | "instagram"
  | "status"
  | "date"
  | "create"
  | "library"
  | "open-calendar"
  | "calendar";
type DemoStep = InboxStep | ContentStep;
type CursorInstruction = { target: string; mode: "pointer" | "text" } | null;

const inboxSequence: Array<{ step: InboxStep; duration: number }> = [
  { step: "overview", duration: 1800 },
  { step: "open-inbox", duration: 1100 },
  { step: "all", duration: 1500 },
  { step: "whatsapp", duration: 1600 },
  { step: "conversation", duration: 2200 },
  { step: "reply", duration: 2400 },
  { step: "sent", duration: 1700 },
  { step: "booked", duration: 2700 },
];

const contentSequence: Array<{ step: ContentStep; duration: number }> = [
  { step: "overview", duration: 1100 },
  { step: "open-content", duration: 800 },
  { step: "content-home", duration: 1100 },
  { step: "new-draft", duration: 800 },
  { step: "prompt", duration: 2100 },
  { step: "generate", duration: 1000 },
  { step: "variants", duration: 1100 },
  { step: "linkedin", duration: 1100 },
  { step: "instagram", duration: 1000 },
  { step: "status", duration: 900 },
  { step: "date", duration: 1100 },
  { step: "create", duration: 900 },
  { step: "library", duration: 1300 },
  { step: "open-calendar", duration: 800 },
  { step: "calendar", duration: 2400 },
];

const cursorTargets: Record<string, CursorInstruction> = {
  "inbox:overview": null,
  "inbox:open-inbox": { target: "inbox-nav", mode: "pointer" },
  "inbox:all": { target: "all-tab", mode: "pointer" },
  "inbox:whatsapp": { target: "whatsapp", mode: "pointer" },
  "inbox:conversation": { target: "thando", mode: "pointer" },
  "inbox:reply": { target: "typing", mode: "text" },
  "inbox:sent": { target: "send", mode: "pointer" },
  "inbox:booked": { target: "booking", mode: "pointer" },
  "content:overview": null,
  "content:open-content": { target: "content-nav", mode: "pointer" },
  "content:content-home": null,
  "content:new-draft": { target: "new-draft", mode: "pointer" },
  "content:prompt": { target: "content-prompt", mode: "text" },
  "content:generate": { target: "generate-variants", mode: "pointer" },
  "content:variants": null,
  "content:linkedin": { target: "variant-linkedin", mode: "pointer" },
  "content:instagram": { target: "variant-instagram", mode: "pointer" },
  "content:status": { target: "content-status", mode: "pointer" },
  "content:date": { target: "content-date", mode: "pointer" },
  "content:create": { target: "create-post", mode: "pointer" },
  "content:library": null,
  "content:open-calendar": { target: "calendar-nav", mode: "pointer" },
  "content:calendar": null,
};

export function ProductWorkspacePreview() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [demo, setDemo] = useState<DemoKind>("inbox");
  const [step, setStep] = useState<DemoStep>("overview");
  const [isVisible, setIsVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [playbackCycle, setPlaybackCycle] = useState(0);
  const [cursor, setCursor] = useState({
    x: 50,
    y: 50,
    mode: "pointer" as "pointer" | "text",
    visible: false,
  });

  const selectDemo = useCallback(
    (nextDemo: DemoKind) => {
      setDemo(nextDemo);
      setStep(reduceMotion ? (nextDemo === "inbox" ? "all" : "content-home") : "overview");
      setIsPlaying(!reduceMotion);
      setPlaybackCycle((cycle) => cycle + 1);
    },
    [reduceMotion],
  );

  const replay = useCallback(() => {
    setStep(reduceMotion ? (demo === "inbox" ? "all" : "content-home") : "overview");
    setIsPlaying(!reduceMotion);
    setPlaybackCycle((cycle) => cycle + 1);
  }, [demo, reduceMotion]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduceMotion(media.matches);
    updateMotion();
    media.addEventListener("change", updateMotion);
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), {
      threshold: 0.35,
    });
    if (frameRef.current) observer.observe(frameRef.current);
    return () => {
      media.removeEventListener("change", updateMotion);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isVisible || reduceMotion || !isPlaying) return;
    const sequence = demo === "inbox" ? inboxSequence : contentSequence;
    let cancelled = false;
    let timeout: number | undefined;
    let index = 0;

    const next = () => {
      if (cancelled || document.hidden) return;
      const item = sequence[index];
      setStep(item.step);
      index = (index + 1) % sequence.length;
      timeout = window.setTimeout(next, item.duration);
    };

    next();
    const visibilityChange = () => {
      if (timeout) window.clearTimeout(timeout);
      if (!document.hidden) next();
    };
    document.addEventListener("visibilitychange", visibilityChange);
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", visibilityChange);
    };
  }, [demo, isVisible, reduceMotion, isPlaying, playbackCycle]);

  useLayoutEffect(() => {
    const instruction = cursorTargets[`${demo}:${step}`];
    if (!instruction || !frameRef.current) return;

    const updateCursor = () => {
      const frame = frameRef.current;
      const target = frame?.querySelector<HTMLElement>(
        `[data-tour-target="${instruction.target}"]`,
      );
      const viewport = frame?.querySelector<HTMLElement>(".product-preview-viewport");
      if (!frame || !viewport || !target) return;
      const viewportBounds = viewport.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      setCursor({
        x:
          (((instruction.mode === "text"
            ? targetBounds.right + 2
            : targetBounds.left + targetBounds.width / 2) -
            viewportBounds.left) /
            viewportBounds.width) *
          100,
        y:
          ((targetBounds.top + targetBounds.height / 2 - viewportBounds.top) /
            viewportBounds.height) *
          100,
        mode: instruction.mode,
        visible: true,
      });
    };

    updateCursor();
    const observer = new ResizeObserver(updateCursor);
    observer.observe(frameRef.current);
    const target = frameRef.current.querySelector<HTMLElement>(
      `[data-tour-target="${instruction.target}"]`,
    );
    if (target) observer.observe(target);
    const mutationObserver = new MutationObserver(() => {
      window.requestAnimationFrame(updateCursor);
    });
    if (target?.parentElement) {
      mutationObserver.observe(target.parentElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    window.addEventListener("resize", updateCursor);
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", updateCursor);
    };
  }, [demo, step]);

  const view = getWorkspaceView(demo, step);
  const title = view === "overview" ? "Overview" : view === "inbox" ? "Inbox" : view === "calendar" ? "Calendar" : "Content";
  const kicker = view === "overview"
    ? "Northstar Studio workspace"
    : view === "inbox"
      ? "Customer conversations in one place"
      : view === "calendar"
        ? "Publishing schedule"
        : "Drafts, variants and publishing";
  const instruction = cursorTargets[`${demo}:${step}`];
  const activeSequence = demo === "inbox" ? inboxSequence : contentSequence;
  const sequenceIndex = activeSequence.findIndex((item) => item.step === step);
  const progress = sequenceIndex < 0 ? 0 : ((sequenceIndex + 1) / activeSequence.length) * 100;
  const sceneLabel = getDemoSceneLabel(demo, step);

  return (
    <div
      className={`product-preview inbox-demo product-film product-film-${demo}`}
      ref={frameRef}
      data-demo={demo}
      data-step={step}
      data-playing={isPlaying && !reduceMotion}
      data-cursor-mode={cursor.mode}
      data-cursor-visible={Boolean(instruction) && cursor.visible}
      style={{
        "--cursor-x": `${cursor.x}%`,
        "--cursor-y": `${cursor.y}%`,
        "--demo-progress": `${progress}%`,
      } as CSSProperties}
    >
      <div className="product-preview-viewport">
        <div className="product-preview-canvas">
          <div className="product-preview-bar">
            <span className="product-preview-brand"><i>K</i> Kasitek</span>
            <span className="product-preview-workspace">Northstar Studio <ChevronDown aria-hidden="true" /></span>
            <div className="product-preview-actions"><Search aria-hidden="true" /><Bell aria-hidden="true" /><span>NS</span></div>
          </div>
          <div className="product-preview-body">
            <WorkspaceNav view={view} />
            <div className="product-preview-main">
              <div className="product-preview-topline">
                <div><span className="scene-kicker">{kicker}</span><strong>{title}</strong></div>
                <span className="workspace-status"><i /> Workspace active</span>
              </div>
              {view === "overview" ? <OverviewDemo /> : null}
              {view === "inbox" ? <InboxDemo step={step as InboxStep} /> : null}
              {view === "content" ? <ContentDemo step={step as ContentStep} /> : null}
              {view === "calendar" ? <ContentCalendarDemo /> : null}
              {demo === "content" && isComposerStep(step) ? (
                <ContentComposer step={step as ContentStep} />
              ) : null}
            </div>
          </div>
        </div>
        <span className="product-tour-cursor" key={`${demo}-${step}`} aria-hidden="true"><MousePointer2 /><i /></span>
      </div>

      <div className="product-demo-switcher" aria-label="Product demonstrations">
        <div className="product-demo-progress" aria-hidden="true">
          <span>{sceneLabel}</span>
          <i><b /></i>
        </div>
        <button type="button" className={demo === "inbox" ? "is-active" : ""} onClick={() => selectDemo("inbox")}>
          Inbox
        </button>
        <button type="button" className={demo === "content" ? "is-active" : ""} onClick={() => selectDemo("content")}>
          Content &amp; Calendar
        </button>
        <button className="preview-replay" type="button" onClick={replay} aria-label={`Replay ${demo} demo`}><RotateCcw aria-hidden="true" /></button>
      </div>
    </div>
  );
}

function getWorkspaceView(demo: DemoKind, step: DemoStep) {
  if (step === "overview" || step === "open-inbox" || step === "open-content") return "overview";
  if (demo === "inbox") return "inbox";
  if (step === "calendar") return "calendar";
  return "content";
}

function isComposerStep(step: DemoStep) {
  return ["prompt", "generate", "variants", "linkedin", "instagram", "status", "date", "create"].includes(step);
}

function getDemoSceneLabel(demo: DemoKind, step: DemoStep) {
  if (demo === "inbox") {
    if (step === "overview" || step === "open-inbox") return "Workspace";
    if (step === "all" || step === "whatsapp") return "Channels";
    if (step === "booked") return "Booking";
    return "Conversation";
  }
  if (step === "overview" || step === "open-content" || step === "content-home") return "Content";
  if (step === "new-draft" || step === "prompt" || step === "generate") return "Draft";
  if (step === "variants" || step === "linkedin" || step === "instagram") return "Variants";
  if (step === "status" || step === "date" || step === "create") return "Schedule";
  return "Calendar";
}

function WorkspaceNav({ view }: { view: "overview" | "inbox" | "content" | "calendar" }) {
  return (
    <aside className="product-preview-nav" aria-label="Kasitek workspace sections">
      <span className="nav-label">Home</span><NavItem icon={LayoutGrid} label="Overview" active={view === "overview"} />
      <span className="nav-label">Customer</span><NavItem icon={Bell} label="Inbox" active={view === "inbox"} target="inbox-nav" /><NavItem icon={PhoneCall} label="Calls" /><NavItem icon={Users} label="Contacts" />
      <span className="nav-label">Growth</span><NavItem icon={Send} label="Campaigns" /><NavItem icon={FileText} label="Templates" /><NavItem icon={Sparkles} label="Content" active={view === "content"} target="content-nav" /><NavItem icon={CalendarDays} label="Calendar" active={view === "calendar"} target="calendar-nav" /><NavItem icon={CalendarCheck} label="Bookings" /><NavItem icon={Grid2x2} label="Analytics" />
      <span className="nav-label">Automation</span><NavItem icon={Bot} label="Agents" />
      <span className="nav-label">Manage</span><NavItem icon={Cable} label="Connections" /><NavItem icon={Users} label="Team" /><NavItem icon={CreditCard} label="Billing & usage" /><NavItem icon={Settings} label="Workspace settings" />
    </aside>
  );
}

function NavItem({ icon: Icon, label, active = false, target }: { icon: typeof Inbox; label: string; active?: boolean; target?: string }) {
  return <span data-tour-target={target} className={active ? "preview-nav-item is-active" : "preview-nav-item"}><Icon aria-hidden="true" />{label}</span>;
}

function OverviewDemo() {
  return <section className="workspace-scene is-active overview-demo-scene" aria-label="Kasitek workspace overview">
    <div className="overview-heading"><span><b>Good morning, Northstar.</b><small>Here is what needs your attention.</small></span><button type="button">View reports</button></div>
    <div className="overview-metrics"><article><small>Open conversations</small><b>12</b><span>4 need a reply</span></article><article><small>Upcoming bookings</small><b>3</b><span>Next: Thu, 10:00</span></article><article><small>Scheduled posts</small><b>6</b><span>3 channels connected</span></article></div>
    <div className="overview-activity"><div><b>Recent workspace activity</b><small>Today</small></div><article><i /><span><b>New WhatsApp enquiry</b><small>Thando Mokoena · Consultation</small></span><time>Now</time></article><article><i /><span><b>Post scheduled</b><small>July consultation availability</small></span><time>12m</time></article></div>
  </section>;
}

function InboxDemo({ step }: { step: InboxStep }) {
  const showingAll = step === "all";
  const channelSelected = !showingAll;
  const conversationOpen = ["conversation", "reply", "sent", "booked"].includes(step);
  const replyVisible = ["reply", "sent", "booked"].includes(step);
  const sent = step === "sent" || step === "booked";
  const booked = step === "booked";
  return <section className="workspace-scene is-active customer-scene inbox-demo-scene" aria-label="Kasitek inbox demonstration">
    <div className="inbox-channel-tabs">
      <Channel icon={Inbox} label="All" active={showingAll} target="all-tab" />
      <Channel icon={MessageCircle} label="WhatsApp" active={channelSelected} live target="whatsapp" />
      <Channel icon={Instagram} label="Instagram" />
      <Channel icon={Facebook} label="Messenger" />
      <Channel icon={Mail} label="Email" planned />
    </div>
    <div className="conversation-list">
      <div className="conversation-search"><Search aria-hidden="true" /> Search conversations</div>
      <Conversation initials="TM" name="Thando Mokoena" message="I would like to book a consultation." active channel="WhatsApp" target="thando" />
      {showingAll ? <><Conversation initials="SV" name="Sive Vena" message="Could you send more information?" channel="Instagram" /><Conversation initials="KN" name="Kamo Ndlovu" message="Can I get a quote first?" channel="Messenger" /></> : null}
    </div>
    {conversationOpen ? <div className="conversation-thread is-open">
      <div className="thread-title"><span><b>Thando Mokoena</b><small><MessageCircle aria-hidden="true" /> WhatsApp · 2 min ago</small></span><MoreHorizontal aria-hidden="true" /></div>
      <div className="message customer-message">Hi, I would like to book a consultation for next week.</div>
      {sent ? <div className="message agent-message sent-message"><Sparkles aria-hidden="true" /> Thursday at 10:00 is available. Would that work for you?</div> : null}
      {booked ? <div className="message customer-message confirmation-message">That works perfectly, thank you.</div> : null}
      <div className={replyVisible && !sent ? "reply-bar is-typing" : "reply-bar"}>{replyVisible && !sent ? <span className="draft-text"><DemoTypedText text="Thursday at 10:00 is available" active delay={300} duration={1150} target="typing" /></span> : <span>Write a reply</span>}<span data-tour-target="send"><Send aria-hidden="true" /></span></div>
    </div> : <div className="inbox-empty"><MessageCircle aria-hidden="true" /><b>Select a conversation</b><span>Choose a customer to view messages and context.</span></div>}
    <aside className={booked ? "contact-panel has-booking" : "contact-panel"}><div className="contact-avatar">TM</div><b>Thando Mokoena</b><span>Customer since May</span><div className="contact-detail" data-tour-target="booking"><small>Next booking</small><strong>{booked ? "Thu, 10:00" : "Not scheduled"}</strong></div><div className="contact-detail"><small>Channel</small><strong>WhatsApp</strong></div></aside>
  </section>;
}

function ContentDemo({ step }: { step: ContentStep }) {
  const scheduled = step === "library" || step === "open-calendar";
  return <section className="workspace-scene is-active content-demo-scene" aria-label="Kasitek content demonstration">
    <div className="content-demo-heading">
      <span><b>Posts</b><small>Draft, tailor and schedule content.</small></span>
      <button type="button" data-tour-target="new-draft"><Wand2 aria-hidden="true" /> New AI Draft</button>
    </div>
    <div className="content-queue">
      <article><small>Ideas</small><b>4</b><span>Waiting for polish</span></article>
      <article><small>Drafting</small><b>2</b><span>Variants in progress</span></article>
      <article><small>Scheduled</small><b>{scheduled ? "7" : "6"}</b><span>Ready to publish</span></article>
    </div>
    <div className="content-library">
      <div className="content-library-head"><b>Post Library</b><span>All&nbsp;&nbsp; Drafts&nbsp;&nbsp; Scheduled</span></div>
      {scheduled ? <ContentPost featured /> : null}
      <ContentPost />
      <ContentPost second />
    </div>
  </section>;
}

function ContentPost({ featured = false, second = false }: { featured?: boolean; second?: boolean }) {
  const title = featured ? "July consultation availability" : second ? "Meet the Northstar team" : "Winter service reminder";
  const status = featured ? "Scheduled · 29 Jul, 09:00" : second ? "Draft" : "Scheduled · 26 Jul, 10:30";
  return <article className={featured ? "content-post is-new" : "content-post"}>
    <span><b>{title}</b><small>{status}</small></span>
    <div><i><Facebook aria-hidden="true" /></i><i><Instagram aria-hidden="true" /></i>{featured ? <i><Linkedin aria-hidden="true" /></i> : null}</div>
    <em>{featured || !second ? "Scheduled" : "Draft"}</em>
  </article>;
}

function ContentComposer({ step }: { step: ContentStep }) {
  const generated = ["variants", "linkedin", "instagram", "status", "date", "create"].includes(step);
  const selected = step === "linkedin" ? "linkedin" : step === "instagram" || ["status", "date", "create"].includes(step) ? "instagram" : "facebook";
  const scheduled = ["date", "create"].includes(step);
  const dated = step === "create";
  return <div className="content-composer-layer">
    <div className="content-composer-scrim" />
    <aside className="content-composer">
      <div className="composer-head"><span><b>New Post</b><small>Build a master post, then tailor each platform.</small></span><i>×</i></div>
      <div className="composer-body">
        <label><span>AI prompt</span><div className="composer-field composer-prompt"><span className="content-typed-prompt"><DemoTypedText text="Announce July consultation availability with a booking link." active={step === "prompt"} delay={360} duration={1600} target="content-prompt" /></span></div></label>
        <button type="button" className={step === "generate" ? "composer-generate is-loading" : "composer-generate"} data-tour-target="generate-variants"><Sparkles aria-hidden="true" />{step === "generate" ? "Generating…" : generated ? "Variants generated" : "Generate Variants"}</button>
        {generated ? <>
          <label><span>Master post summary</span><div className="composer-field composer-summary">July consultation bookings are open. Choose a time that works for your team.</div></label>
          <div className="variant-tabs">
            <button className={selected === "facebook" ? "is-active" : ""} type="button"><Facebook aria-hidden="true" /> Facebook</button>
            <button className={selected === "instagram" ? "is-active" : ""} type="button" data-tour-target="variant-instagram"><Instagram aria-hidden="true" /> Instagram</button>
            <button className={selected === "linkedin" ? "is-active" : ""} type="button" data-tour-target="variant-linkedin"><Linkedin aria-hidden="true" /> LinkedIn</button>
          </div>
          <div className="variant-copy">
            <span>{selected === "linkedin" ? "LinkedIn copy" : selected === "instagram" ? "Instagram copy" : "Facebook copy"}</span>
            <p>{selected === "linkedin" ? "July consultation bookings are now open for teams reviewing their customer operations. Choose a suitable time to discuss the workflow and next steps." : selected === "instagram" ? "July bookings are open. Choose your consultation time through the link in our profile." : "Planning for July? Consultation bookings are now open. Choose a time that works for you."}</p>
          </div>
          <div className="composer-schedule-row">
            <label><span>Status</span><div className={scheduled ? "composer-select is-set" : "composer-select"} data-tour-target="content-status">{scheduled ? "Scheduled" : "Draft"}<ChevronDown aria-hidden="true" /></div></label>
            <label><span>Schedule</span><div className={dated ? "composer-select is-set" : "composer-select"} data-tour-target="content-date">{dated ? "29 Jul 2026 · 09:00" : "Choose date & time"}<CalendarDays aria-hidden="true" /></div></label>
          </div>
        </> : null}
      </div>
      <div className="composer-footer"><button type="button">Cancel</button><button type="button" className="composer-create" data-tour-target="create-post"><Check aria-hidden="true" /> Create Post</button></div>
    </aside>
  </div>;
}

function ContentCalendarDemo() {
  const days = [24, 25, 26, 27, 28, 29, 30, 31, 1, 2, 3, 4, 5, 6];
  return <section className="workspace-scene is-active content-calendar-scene" aria-label="Kasitek publishing calendar demonstration">
    <div className="calendar-demo-heading"><span><b>July 2026</b><small>Monthly Publishing Calendar</small></span><div><button type="button">‹</button><button type="button">›</button></div></div>
    <div className="calendar-demo-layout">
      <div className="calendar-demo-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span className="calendar-weekday" key={day}>{day}</span>)}
        {days.map((day, index) => <article key={`${day}-${index}`} className={day === 29 ? "has-post" : ""}><b>{day}</b>{day === 29 ? <div><strong>July consultation availability</strong><small>FB · IG · LI</small></div> : day === 26 ? <div className="quiet"><strong>Winter reminder</strong><small>FB · IG</small></div> : <i />}</article>)}
      </div>
      <aside className="calendar-upcoming"><b>Upcoming Schedule</b><article><span>29 Jul · 09:00</span><strong>July consultation availability</strong><small>Facebook · Instagram · LinkedIn</small></article><article><span>31 Jul · 11:30</span><strong>Customer story</strong><small>Facebook · LinkedIn</small></article></aside>
    </div>
  </section>;
}

function Channel({ icon: Icon, label, active = false, live = false, planned = false, target }: { icon: typeof Inbox; label: string; active?: boolean; live?: boolean; planned?: boolean; target?: string }) {
  return <span data-tour-target={target} className={`${active ? "is-active " : ""}${planned ? "is-planned" : ""}`}><Icon aria-hidden="true" />{label}{live ? <i aria-label="Connected" /> : null}</span>;
}

function Conversation({ initials, name, message, active = false, channel, target }: { initials: string; name: string; message: string; active?: boolean; channel: string; target?: string }) {
  return <div data-tour-target={target} className={active ? "conversation is-active" : "conversation"}><i>{initials}</i><span><b>{name}</b><small>{message}</small></span><u>{channel}</u></div>;
}

function DemoTypedText({
  text,
  active,
  delay,
  duration,
  target,
}: {
  text: string;
  active: boolean;
  delay: number;
  duration: number;
  target: string;
}) {
  const [visibleCharacters, setVisibleCharacters] = useState(active ? 0 : text.length);

  useEffect(() => {
    if (!active) return;

    let animationFrame = 0;
    let delayTimer = 0;

    delayTimer = window.setTimeout(() => {
      const startedAt = performance.now();
      const typeNextCharacter = (now: number) => {
        const progress = Math.min((now - startedAt) / duration, 1);
        setVisibleCharacters(Math.min(text.length, Math.floor(progress * text.length)));
        if (progress < 1) {
          animationFrame = window.requestAnimationFrame(typeNextCharacter);
        }
      };
      animationFrame = window.requestAnimationFrame(typeNextCharacter);
    }, delay);

    return () => {
      window.clearTimeout(delayTimer);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [active, delay, duration, text]);

  const renderedCharacters = active ? visibleCharacters : text.length;

  return (
    <span className="demo-typed-text">
      {text.slice(0, renderedCharacters)}
      {active ? (
        <i
          className="demo-typing-caret"
          data-tour-target={target}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
