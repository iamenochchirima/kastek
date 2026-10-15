import type { Metadata } from "next";
import {
  Facebook,
  Instagram,
  MessageCircle,
  Send,
  Sparkles,
  Workflow,
} from "lucide-react";
import { ContactPanel, InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";

export const metadata: Metadata = {
  title: "Meta Business Platform | Kasitek Labs",
  description:
    "WhatsApp Business, Facebook Pages and Instagram professional accounts connected to Kasitek through official Meta APIs.",
};

const channels = [
  {
    title: "WhatsApp Business",
    description: "Messages, templates, campaigns and workflow events.",
    icon: MessageCircle,
  },
  {
    title: "Facebook Pages",
    description: "Page messages, comments and customer activity.",
    icon: Facebook,
  },
  {
    title: "Instagram",
    description: "Professional account messaging, publishing and engagement.",
    icon: Instagram,
  },
];

const work = [
  {
    title: "Messaging",
    description: "Handle connected conversations from the Kasitek inbox.",
    icon: Send,
  },
  {
    title: "Publishing",
    description: "Create, schedule and review Facebook and Instagram content.",
    icon: Sparkles,
  },
  {
    title: "Automation",
    description:
      "Use messages and channel events to start controlled workflows.",
    icon: Workflow,
  },
];

export default function MetaBusinessPlatformPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Meta Business Platform"
        title={<>Connect the channels your business uses.</>}
        introduction="Kasitek connects WhatsApp Business, Facebook Pages and Instagram professional accounts through official Meta APIs."
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>Connected accounts.</h2>
          <p>Your business keeps ownership and chooses the access it grants.</p>
        </div>
        <div className="editorial-grid editorial-grid-three">
          {channels.map((channel) => (
            <article className="editorial-card" key={channel.title}>
              <channel.icon aria-hidden="true" />
              <h2>{channel.title}</h2>
              <p>{channel.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="inner-section inner-section-muted">
        <div className="inner-section-heading">
          <h2>What Kasitek adds.</h2>
          <p>One workspace around the connected channels.</p>
        </div>
        <div className="feature-list">
          {work.map((item) => (
            <article className="feature-row" key={item.title}>
              <h3>
                <item.icon aria-hidden="true" />
                {item.title}
              </h3>
              <p>{item.description}</p>
            </article>
          ))}
        </div>
      </section>

      <ContactPanel
        title="Connect your business channels."
        subject="Meta platform enquiry"
      />
    </LabsInnerShell>
  );
}
