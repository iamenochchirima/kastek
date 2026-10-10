"use client";

import { useState, type CSSProperties } from "react";
import { ArrowRight, ArrowUp, ArrowUpRight, CalendarDays, Check, ChevronDown, FileText, Globe, Inbox, Mail, MessageSquare, MoreHorizontal, Paperclip, Search, Send, Users } from "lucide-react";
import styles from "./landing.module.css";

// Illustrative product scenes. These interactions only change the local preview.
export function AgentPreview() {
  const [view, setView] = useState("chat");
  return (
    <div className={styles.agentScene}>
      <div className={styles.sceneTabs} role="group" aria-label="Agent preview">
        <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}><Globe size={14} />Website chat</button>
        <button type="button" aria-pressed={view === "inbox"} onClick={() => setView("inbox")}><Inbox size={14} />Team inbox</button>
      </div>
      <div className={styles.agentStage}>
        <div className={styles.knowledgeCard}><span className={styles.smallLabel}>Knowledge</span><h3>A good answer starts here.</h3><div><FileText size={18} /><span>Returns & exchanges<small>Store policy</small></span><Check size={13} /></div><div><FileText size={18} /><span>Delivery information<small>Shipping guide</small></span><Check size={13} /></div><p>Available to your agent</p></div>
        <div className={styles.chatWindow}>
          <div className={styles.windowHeader}><span className={styles.storeAvatar}>a.</span><span><b>Acorn Store</b><small>{view === "chat" ? "Usually replies right away" : "Customer conversations"}</small></span><MoreHorizontal size={19} /></div>
          {view === "chat" ? <div className={styles.chatBody}><span className={styles.chatDate}>Today</span><p className={styles.customerMessage}>Hi, can I return something if it doesn’t fit?</p><div className={styles.answer}><span className={styles.smallStoreAvatar}>a.</span><p>Yes. You have 30 days from delivery. Just keep it unused and in its original packaging.</p></div><span className={styles.answerSource}><FileText size={11} />Returns & exchanges</span><p className={styles.customerMessage}>Great, thanks. I’d like help with an exchange.</p><div className={styles.answer}><span className={styles.smallStoreAvatar}>a.</span><p>I’ll connect you with the team to arrange it.</p></div><span className={styles.handoff}><span />Maya has joined the conversation</span></div> : <div className={styles.chatBody}><span className={styles.chatDate}>Assigned to Maya</span><div className={styles.inboxPerson}><span className={styles.personAvatar}>TN</span><span><b>Thandi N.</b><small>Exchange enquiry · Website</small></span><span className={styles.openStatus}>Open</span></div><p className={styles.customerMessage}>Great, thanks. I’d like help with an exchange.</p><div className={styles.answer}><span className={styles.personAvatar}>M</span><p>Hi Thandi, I can help with that. What’s your order number?</p></div><div className={styles.privateNote}><span>Private note</span><p>Customer has read the returns policy. Confirm size availability before arranging the exchange.</p></div></div>}
          <div className={styles.chatComposer}><span>{view === "chat" ? "Write a message…" : "Reply to Thandi…"}</span><span><Paperclip size={15} /><i><ArrowUp size={14} /></i></span></div>
        </div>
        <div className={styles.handoffCard}><span className={styles.personAvatar}>M</span><div><b>A person when it matters.</b><p>The conversation stays in one place.</p></div><MessageSquare size={18} /></div>
      </div>
      <span className={styles.sampleCaption}>Sample conversation</span>
    </div>
  );
}

const campaigns = [
  { name: "Spring collection", audience: "Returning customers", status: "Scheduled", channel: "Email", color: styles.campaignSand },
  { name: "A little thank you", audience: "Recent customers", status: "Draft", channel: "Email", color: styles.campaignOlive },
  { name: "Weekend at Acorn", audience: "Local customers", status: "Draft", channel: "WhatsApp", color: styles.campaignClay },
];

export function GrowthPreview() {
  const [view, setView] = useState("Campaigns");
  return (
    <div className={styles.growthScene}>
      <div className={styles.growthWindow}>
        <aside className={styles.appSidebar}><b>K<span>.</span></b><div className={styles.workspaceName}>Acorn Store <ChevronDown size={11} /></div><div className={styles.sideItems}><span><Inbox size={14} />Inbox</span><span><Users size={14} />Contacts</span><button type="button" aria-pressed={view === "Campaigns"} onClick={() => setView("Campaigns")}><Send size={14} />Campaigns</button><span><FileText size={14} />Content</span><button type="button" aria-pressed={view === "Calendar"} onClick={() => setView("Calendar")}><CalendarDays size={14} />Calendar</button></div><span className={styles.sidebarUser}><span className={styles.personAvatar}>M</span>Maya Jacobs</span></aside>
        <div className={styles.growthMain}><div className={styles.appTopbar}><span>Workspace <span>/</span> {view}</span><Search size={14} /></div><div className={styles.growthBody}><div className={styles.appHeading}><div><h3>{view}</h3><p>{view === "Campaigns" ? "A good reason to get in touch." : "The week ahead."}</p></div><span className={styles.staticAction}>{view === "Campaigns" ? "New campaign" : "October"}<span>+</span></span></div>{view === "Campaigns" ? <><div className={styles.appFilter}>All campaigns <span>Drafts</span><span>Scheduled</span></div><div className={styles.campaignGrid}>{campaigns.map(campaign => <div className={styles.campaignCard} key={campaign.name}><div className={`${styles.campaignArt} ${campaign.color}`}><span>acorn.</span><strong>{campaign.name === "Spring collection" ? <>A fresh<br /><em>start.</em></> : campaign.name === "A little thank you" ? <>Just<br /><em>for you.</em></> : <>Slow<br /><em>Saturdays.</em></>}</strong><div /></div><div className={styles.campaignDetails}><span><Mail size={11} />{campaign.channel}</span><h4>{campaign.name}</h4><p>{campaign.audience}</p><small>{campaign.status}<ArrowUpRight size={11} /></small></div></div>)}</div><div className={styles.scheduleNote}><CalendarDays size={15} /><span>Spring collection <small>Scheduled for Thursday, 09:00</small></span><ArrowRight size={15} /></div></> : <div className={styles.calendarPreview}>{["Mon", "Tue", "Wed", "Thu", "Fri"].map((day, index) => <div key={day}><span>{day}<b>{12 + index}</b></span>{index === 1 && <p>Draft weekend post<small>Content</small></p>}{index === 3 && <p>Spring collection<small>Email · 09:00</small></p>}{index === 4 && <p>Customer follow-up<small>Campaign</small></p>}</div>)}</div>}</div></div>
      </div><span className={styles.sampleCaption}>Sample workspace</span>
    </div>
  );
}

export function AgencyPreview() {
  const [brand, setBrand] = useState("#697b65");
  return (
    <div className={styles.agencyScene} style={{ "--portal-accent": brand } as CSSProperties}>
      <div className={styles.agencyManager}><div className={styles.windowHeader}><span className={styles.studioAvatar}>m.</span><span><b>Moyo Studio</b><small>Business manager</small></span><ChevronDown size={14} /></div><div className={styles.managerBody}><div className={styles.managerHeading}><h3>Your businesses</h3><span>+ Add business</span></div>{[{ name: "Acorn Store", letter: "a.", detail: "Retail", className: styles.businessAcorn }, { name: "Kaya Dental", letter: "k.", detail: "Healthcare", className: styles.businessKaya }, { name: "Lena Beauty", letter: "l.", detail: "Beauty & wellness", className: styles.businessLena }].map(business => <div className={styles.businessRow} key={business.name}><span className={business.className}>{business.letter}</span><div><b>{business.name}</b><small>{business.detail}</small></div><ArrowUpRight size={16} /></div>)}</div></div>
      <div className={styles.clientPortal}><div className={styles.portalHeader}><span>acorn.</span><span>Client portal <span className={styles.portalAvatar}>T</span></span></div><div className={styles.portalBody}><small>Acorn Store</small><h3>Welcome back,<br /><em>Thandi.</em></h3><p>Your team, conversations and reports.</p><div className={styles.portalTiles}><div><MessageSquare size={18} /><span>Conversations</span><ArrowUpRight size={13} /></div><div><FileText size={18} /><span>Reports</span><ArrowUpRight size={13} /></div></div><div className={styles.portalTeam}><span>YOUR TEAM</span><div><span className={styles.personAvatar}>M</span><span><b>Maya Jacobs</b><small>Account manager</small></span><Mail size={15} /></div></div></div></div>
      <div className={styles.palette}><span>Make it yours</span><div role="group" aria-label="Portal brand colour">{[{ name: "Sage", value: "#697b65" }, { name: "Clay", value: "#9d6855" }, { name: "Slate", value: "#606e82" }].map(colour => <button key={colour.value} type="button" aria-label={colour.name} aria-pressed={brand === colour.value} onClick={() => setBrand(colour.value)} style={{ background: colour.value }}>{brand === colour.value && <Check size={11} />}</button>)}</div></div>
      <span className={styles.sampleCaption}>Sample business & client portal</span>
    </div>
  );
}
