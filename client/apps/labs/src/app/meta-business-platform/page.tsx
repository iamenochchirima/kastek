import type { Metadata } from "next";
import {
  BarChart3,
  Bot,
  Facebook,
  Instagram,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { ContactPanel, InnerHero } from "@/components/labs-inner-page";

export const metadata: Metadata = {
  title: "Meta Business Platform | Kasitek Labs",
  description:
    "Official WhatsApp Business, Facebook Page and Instagram Business integrations through Kasitek.",
};

const channels = [
  {
    title: "WhatsApp Business",
    description:
      "Customer conversations, approved templates, campaign replies, delivery events and automated workflows.",
    icon: MessageCircle,
  },
  {
    title: "Facebook Pages",
    description:
      "Page messages, activity, comments and customer engagement managed from the Kasitek workspace.",
    icon: Facebook,
  },
  {
    title: "Instagram Business",
    description:
      "Messaging, publishing workflows, post activity, comments and account engagement.",
    icon: Instagram,
  },
];

const capabilities = [
  {
    title: "Permissioned access",
    description:
      "Clients connect business-owned Meta assets and grant the permissions required for the selected service.",
  },
  {
    title: "Multi-channel inbox",
    description:
      "Messages, replies, comments and customer conversations can be handled across connected channels.",
  },
  {
    title: "Publishing",
    description:
      "Teams can create, schedule and manage Facebook and Instagram content workflows.",
  },
  {
    title: "WhatsApp campaigns",
    description:
      "Approved templates support customer updates, reminders and campaign activity.",
  },
  {
    title: "Routing and automation",
    description:
      "Conversations can be assigned to staff, passed through workflows or handed from AI to a person.",
  },
  {
    title: "Operational reporting",
    description:
      "Delivery status, webhook events, campaign activity and engagement remain visible.",
  },
];

export default function MetaBusinessPlatformPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Meta Business Platform"
        title={<>Official business channels, one operating workspace.</>}
        introduction="Kasitek connects WhatsApp Business, Facebook Pages and Instagram Business for messaging, publishing, automation and reporting through official Meta APIs."
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>The channels teams already use.</h2>
          <p>
            Connected accounts remain client-owned. Kasitek provides the
            workspace and operating layer around them.
          </p>
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
          <h2>Messaging, publishing and automation.</h2>
          <p>
            The connected service is configured around the channels and
            permissions each client chooses to enable.
          </p>
        </div>
        <div className="feature-list">
          {capabilities.map((capability) => (
            <article className="feature-row" key={capability.title}>
              <h3>{capability.title}</h3>
              <p>{capability.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="inner-section inner-section-dark">
        <div className="editorial-grid editorial-grid-three">
          <article className="editorial-card">
            <ShieldCheck aria-hidden="true" />
            <h3>Official API access</h3>
            <p>
              The integration uses permissioned Meta platform APIs—not
              unofficial WhatsApp Web scraping or grey-market sending tools.
            </p>
          </article>
          <article className="editorial-card">
            <Bot aria-hidden="true" />
            <h3>AI with human control</h3>
            <p>
              AI can draft, classify, route and respond within defined roles,
              with staff ready to review or take over.
            </p>
          </article>
          <article className="editorial-card">
            <BarChart3 aria-hidden="true" />
            <h3>Operational visibility</h3>
            <p>
              Teams can review delivery, engagement, campaign activity, inbox
              volume and workflow outcomes.
            </p>
          </article>
        </div>
      </section>

      <ContactPanel
        title="Connect the channels your operation already uses."
        subject="Meta platform enquiry"
      />
    </LabsInnerShell>
  );
}
