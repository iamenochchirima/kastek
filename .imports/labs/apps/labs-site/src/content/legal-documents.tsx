import type { DocumentSection } from "@/components/labs-inner-page";

const privacyEmail = (
  <a href="mailto:info@kasitek.co.za">info@kasitek.co.za</a>
);

export const privacySections: DocumentSection[] = [
  {
    title: "Overview",
    paragraphs: [
      "KasiTek collects and processes information that is necessary to provide websites, AI agents, messaging systems, automation systems, customer support, social management, and related digital services.",
      "This may include contact details, account information, business information, technical usage data, and information submitted through forms, chats, or onboarding flows.",
    ],
  },
  {
    title: "What We Collect",
    paragraphs: [
      "Name, email address, phone number, business name, and service enquiry details.",
      "Account and authentication information for platform access.",
      "Usage, device, browser, and interaction data needed for analytics, security, and service improvement.",
      "Business content and operational data provided for website, agent, campaign, or automation setup.",
      "Information received from connected communication and social platforms where a client chooses to connect those services to KasiTek.",
    ],
  },
  {
    title: "Connected Platform Data",
    paragraphs: [
      "KasiTek allows clients to connect business communication and social channels such as WhatsApp Business, Facebook Pages, Instagram Business, and similar supported services. When a client connects these channels, we process the information needed to provide the features they enable.",
      "Depending on the connected channel and permissions granted, this may include account and profile information, page or channel identifiers, message and conversation content, comments and replies, posts or scheduled content, template and campaign information, delivery or engagement status, and related service logs.",
      "We use this information to provide the service requested by the client, including inbox management, message sending and receiving, social publishing, automation, reporting, support, security, troubleshooting, and compliance with applicable platform requirements.",
      "KasiTek does not sell customer message content, connected social account data, or platform data received through connected third-party services.",
    ],
  },
  {
    title: "How We Use Information",
    paragraphs: [
      "To deliver, maintain, improve, and support KasiTek services.",
      "To communicate with clients about projects, billing, updates, and support.",
      "To operate account access, onboarding, analytics, and security controls.",
      "To operate connected inboxes, social publishing, messaging, automation, reporting, and customer support workflows on behalf of clients.",
      "To comply with legal obligations and enforce our service terms.",
    ],
  },
  {
    title: "Sharing Of Information",
    paragraphs: [
      "KasiTek may share information with infrastructure, hosting, analytics, messaging, payment, and authentication providers where necessary to operate the service.",
      "Information is not sold to third parties. Data may also be disclosed where required by law or to protect the security and integrity of the platform.",
      "Where a client connects third-party platforms such as Meta, WhatsApp, Facebook, or Instagram, data may be transmitted to or received from those platforms to provide the connected service. Use of those platforms is also subject to their own terms and policies.",
    ],
  },
  {
    title: "Data Retention",
    paragraphs: [
      "KasiTek retains personal and business data only for as long as it is reasonably needed to deliver services, maintain records, meet legal obligations, resolve disputes, and support legitimate business operations.",
    ],
  },
  {
    title: "Your Rights",
    paragraphs: [
      "You may request access to, correction of, or deletion of personal data held by KasiTek, subject to legal, operational, and security requirements. Data deletion requests can be submitted through our dedicated data deletion page.",
      "Clients can also disconnect connected Meta, WhatsApp, Facebook, or Instagram accounts from their workspace where supported. Disconnection may stop future syncing while some historical records may be retained where required for security, legal, audit, billing, or operational reasons.",
    ],
  },
  {
    title: "Contact",
    paragraphs: [
      <>
        For privacy-related questions, contact KasiTek at {privacyEmail}.
      </>,
    ],
  },
];

export const termsSections: DocumentSection[] = [
  {
    title: "Overview",
    paragraphs: [
      "These terms govern access to and use of KasiTek websites, software, AI agents, messaging systems, automation services, and related deliverables.",
      "By using KasiTek services, you agree to these terms and any applicable project-specific agreements, quotations, or service schedules.",
    ],
  },
  {
    title: "Services",
    paragraphs: [
      "KasiTek provides digital services including websites, AI agents, campaigns, outreach systems, messaging systems, social management tools, automation workflows, and related support. Exact scope, pricing, timelines, and deliverables are defined in the relevant quotation, agreement, or project terms.",
    ],
  },
  {
    title: "Client Responsibilities",
    paragraphs: [
      "Clients must provide accurate information, required approvals, and timely access to systems and accounts.",
      "Clients remain responsible for third-party platform accounts, policy compliance, and content they provide.",
      "Clients must ensure they have the right to use any data, assets, or materials supplied to KasiTek.",
      "Clients are responsible for the legality, accuracy, consent status, and compliance of contact lists, message recipients, campaign audiences, templates, posts, comments, media, and other content submitted to or managed through KasiTek.",
    ],
  },
  {
    title: "Meta And Third-Party Platforms",
    paragraphs: [
      "KasiTek may allow clients to connect third-party platforms such as WhatsApp Business, Facebook Pages, Instagram Business, and other communication or social channels. These integrations depend on the relevant platform APIs, permissions, review decisions, account status, rate limits, policies, and availability.",
      "Clients are responsible for complying with all applicable third-party platform terms, including Meta and WhatsApp policies, messaging rules, commerce rules, template requirements, consent and opt-in requirements, campaign restrictions, and content standards.",
      "KasiTek may suspend, limit, or remove access to messaging, publishing, automation, or campaign features where needed to protect platform integrity, comply with third-party requirements, respond to abuse, or prevent policy violations.",
    ],
  },
  {
    title: "Messaging And Social Content",
    paragraphs: [
      "Clients control the content they send, publish, schedule, automate, or approve through KasiTek, including WhatsApp messages, Facebook Page content, Instagram content, comments, replies, templates, campaigns, and media.",
      "Clients must only message people where they have a valid basis to do so and must honor opt-outs, unsubscribe requests, customer preferences, and applicable privacy and electronic communications laws.",
      "AI-assisted features may draft, classify, route, summarize, or recommend responses, but clients remain responsible for reviewing outputs where appropriate and for the final use of content in their business.",
    ],
  },
  {
    title: "Fees And Payments",
    paragraphs: [
      "Fees are due according to the applicable quotation or agreement. Third-party platform costs, messaging charges, hosting, or API fees may be billed separately unless explicitly stated otherwise in writing.",
    ],
  },
  {
    title: "Intellectual Property",
    paragraphs: [
      "KasiTek retains ownership of its pre-existing tools, systems, methods, templates, and platform components. Client-owned content, branding, and proprietary business materials remain the property of the client unless otherwise agreed.",
    ],
  },
  {
    title: "No Warranty",
    paragraphs: [
      "Services are provided on a reasonable-efforts basis. KasiTek does not guarantee specific business outcomes, uninterrupted third-party platform availability, or error-free operation at all times.",
      "KasiTek does not control third-party platform decisions, including account restrictions, app review outcomes, template approvals, message delivery, reach, ranking, rate limits, or policy enforcement by Meta, WhatsApp, Facebook, Instagram, or other platforms.",
    ],
  },
  {
    title: "Limitation Of Liability",
    paragraphs: [
      "To the maximum extent permitted by law, KasiTek is not liable for indirect, incidental, special, consequential, or lost-profit damages arising from use of the service or from third-party platforms and integrations.",
    ],
  },
  {
    title: "Termination",
    paragraphs: [
      "KasiTek may suspend or terminate service access for non-payment, policy violations, abuse, security concerns, or material breach of agreement. Clients may discontinue services according to the applicable notice or contract terms.",
    ],
  },
  {
    title: "Contact",
    paragraphs: [
      <>For questions about these terms, contact {privacyEmail}.</>,
    ],
  },
];

export const deletionSections: DocumentSection[] = [
  {
    title: "Requesting Deletion",
    paragraphs: [
      "If you would like KasiTek to delete personal or business data associated with your account or use of our services, you may submit a request by email.",
      "Please include your full name, business name, email address, phone number, and a clear description of the data or account you want deleted.",
    ],
  },
  {
    title: "Connected Meta Accounts",
    paragraphs: [
      "If your workspace connects WhatsApp Business, Facebook Pages, Instagram Business, or other Meta business assets, you can request deletion of data KasiTek stores from those connections. This may include connected account records, message and conversation history, templates, comments, posts, media metadata, webhook events, campaign records, analytics, and related operational logs.",
      "You may also disconnect KasiTek from your Meta business assets through your workspace settings where available, or by removing the app connection in Meta Business settings. Disconnecting stops future access or syncing where technically supported.",
    ],
  },
  {
    title: "How To Request Deletion",
    paragraphs: [
      <>
        Send your request to{" "}
        <a href="mailto:info@kasitek.co.za?subject=Data%20Deletion%20Request">
          info@kasitek.co.za
        </a>{" "}
        with the subject line “Data Deletion Request”.
      </>,
    ],
  },
  {
    title: "Verification",
    paragraphs: [
      "KasiTek may request additional information to verify identity and confirm authority over the account or data before processing deletion.",
    ],
  },
  {
    title: "Processing Time",
    paragraphs: [
      "KasiTek will review deletion requests and respond within a reasonable period. Where a request relates to a business workspace, we may need confirmation from an authorized owner or administrator before deleting shared business data.",
    ],
  },
  {
    title: "Important Note",
    paragraphs: [
      "Some information may need to be retained where required for legal, tax, security, fraud prevention, contractual, or operational reasons.",
      "Deleting data from KasiTek does not automatically delete data held by Meta, WhatsApp, Facebook, Instagram, or other third-party platforms. You may need to manage those records directly with the relevant platform.",
    ],
  },
];
