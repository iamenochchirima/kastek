import {
  BriefcaseBusiness,
  Building2,
  Layers3,
  Store,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SolutionDemoKind =
  | "website-agent"
  | "whatsapp-agent"
  | "catalogue-agent"
  | "quote-automation"
  | "voice-agent"
  | "lead-nurturing"
  | "reviews"
  | "reporting"
  | "content-engine"
  | "aeo"
  | "platform-embed"
  | "usage-reporting"
  | "tenant-provisioning"
  | "coming-soon";

export type SolutionService = {
  title: string;
  description: string;
  demoKind: SolutionDemoKind;
};

export type SolutionCategory = {
  slug: string;
  title: string;
  shortTitle: string;
  summary: string;
  examples: string[];
  intro: string;
  menuLabel: string;
  icon: LucideIcon;
  readiness: "active" | "coming-soon";
  primarySectionTitle: string;
  primarySectionDescription: string;
  primaryServices: SolutionService[];
  secondarySectionTitle: string;
  secondarySectionDescription: string;
  secondaryServices: SolutionService[];
};

export const solutionCategories: SolutionCategory[] = [
  {
    slug: "smbs",
    title: "SMBs",
    shortTitle: "SMBs",
    menuLabel: "SMBs",
    summary:
      "Ready-made platform services and custom builds for businesses that need faster response, follow-up, and conversion.",
    examples: [
      "Retail Stores",
      "Clinics",
      "Restaurants",
      "Salons",
      "Home Services",
    ],
    intro:
      "For business owners who want practical AI systems that help them capture leads, answer customers, automate follow-up, and keep operations moving.",
    icon: BriefcaseBusiness,
    readiness: "active",
    primarySectionTitle: "Platform Services",
    primarySectionDescription:
      "The ready-made service layer you can deploy first.",
    primaryServices: [
      {
        title: "Website Agent",
        description:
          "Live website enquiries, lead capture, and instant responses without missed opportunities.",
        demoKind: "website-agent",
      },
      {
        title: "WhatsApp Agent",
        description:
          "Handle FAQs, bookings, support, and sales conversations inside WhatsApp.",
        demoKind: "whatsapp-agent",
      },
      {
        title: "WhatsApp Catalogue",
        description:
          "Let customers browse products, ask questions, and place orders conversationally.",
        demoKind: "catalogue-agent",
      },
      {
        title: "Bulk Campaigns",
        description:
          "Run repeat customer outreach, promotions, and follow-up campaigns from one flow.",
        demoKind: "lead-nurturing",
      },
      {
        title: "Content Workflows",
        description:
          "Generate posts, offers, and campaign assets to keep your business visible.",
        demoKind: "content-engine",
      },
    ],
    secondarySectionTitle: "Custom Services",
    secondarySectionDescription:
      "Built around the way your business actually runs.",
    secondaryServices: [
      {
        title: "Booking Systems",
        description:
          "Appointment and enquiry flows connected to the way your team actually schedules and confirms work.",
        demoKind: "whatsapp-agent",
      },
      {
        title: "Quotation Automation",
        description:
          "Generate quotations automatically from customer requests, job details, and pricing rules.",
        demoKind: "quote-automation",
      },
      {
        title: "Voice Agents",
        description:
          "After-hours call handling, triage, routing, and common request automation.",
        demoKind: "voice-agent",
      },
      {
        title: "Nurturing & Reviews",
        description:
          "Reminder flows, follow-up sequences, and review requests that keep leads warm and customers visible.",
        demoKind: "reviews",
      },
      {
        title: "Custom Reporting",
        description:
          "Dashboards, visibility layers, and integrations tailored to your operation.",
        demoKind: "reporting",
      },
    ],
  },
  {
    slug: "agencies",
    title: "Agencies & Consultants",
    shortTitle: "Agencies",
    menuLabel: "Agencies",
    summary:
      "Partner-ready services agencies and consultants can offer under their own brand, with delivery support behind the scenes.",
    examples: [
      "Marketing Agencies",
      "Consultants",
      "Web Studios",
      "Growth Partners",
    ],
    intro:
      "For agencies and consultants that want to add AI services to their offering without building the infrastructure from scratch.",
    icon: Building2,
    readiness: "active",
    primarySectionTitle: "Partner-Ready Services",
    primarySectionDescription:
      "The service catalogue you can package and resell.",
    primaryServices: [
      {
        title: "Conversational Lead Generation",
        description:
          "Website, WhatsApp, Instagram, and voice services agencies can package for lead capture and support.",
        demoKind: "website-agent",
      },
      {
        title: "Lead Nurturing & Reviews",
        description:
          "Automated follow-up, reminders, and review flows for better client retention.",
        demoKind: "reviews",
      },
      {
        title: "Content & Creative Engine",
        description:
          "Blogs, social posts, ad copy, creative variants, and campaign assets for client delivery.",
        demoKind: "content-engine",
      },
      {
        title: "Branded Reporting",
        description:
          "Client-facing dashboards and reporting delivered under the agency brand.",
        demoKind: "reporting",
      },
      {
        title: "Voice & Quotation Add-ons",
        description:
          "Recurring service add-ons for after-hours calls, qualification, and quote generation.",
        demoKind: "voice-agent",
      },
    ],
    secondarySectionTitle: "Custom Partner Builds",
    secondarySectionDescription:
      "For agencies that need deeper delivery support or unique service models.",
    secondaryServices: [
      {
        title: "Client-Specific Workflows",
        description:
          "Handoff logic, onboarding, and service flows tailored to the client engagement model.",
        demoKind: "lead-nurturing",
      },
      {
        title: "Branded Portals",
        description:
          "Agency-facing and client-facing dashboards, portals, and reporting experiences.",
        demoKind: "reporting",
      },
      {
        title: "Campaign Automations",
        description:
          "Automations tied to the agency process for acquisition, follow-up, and retention.",
        demoKind: "lead-nurturing",
      },
      {
        title: "Industry Packages",
        description:
          "Packaged solutions for healthcare, home services, retail, and other repeatable verticals.",
        demoKind: "platform-embed",
      },
      {
        title: "Rollout Support",
        description:
          "Delivery support for launch, optimisation, and recurring agency service operations.",
        demoKind: "tenant-provisioning",
      },
    ],
  },
  {
    slug: "software-vendors",
    title: "Software Vendors",
    shortTitle: "Software Vendors",
    menuLabel: "Software Vendors",
    summary:
      "Embedded AI service layers, branded experiences, and custom platform extensions for software products serving business customers.",
    examples: [
      "SaaS",
      "Client Portals",
      "Industry Platforms",
      "Workflow Tools",
    ],
    intro:
      "For software vendors who want to expand their product with customer communication, automation, and AI-assisted growth services.",
    icon: Layers3,
    readiness: "active",
    primarySectionTitle: "Embedded Solution Areas",
    primarySectionDescription:
      "The core service layers vendors can add to their product offering.",
    primaryServices: [
      {
        title: "Embedded Conversation Layer",
        description:
          "Conversation agents for websites, messaging, and support channels inside the product experience.",
        demoKind: "platform-embed",
      },
      {
        title: "Nurturing Workflows",
        description:
          "Conversion and retention flows tied to product events, onboarding, and user activity.",
        demoKind: "lead-nurturing",
      },
      {
        title: "Content Modules",
        description:
          "Content and creative engines that complement existing product modules and customer needs.",
        demoKind: "content-engine",
      },
      {
        title: "Reporting Surfaces",
        description:
          "Usage, campaign, and outcome reporting built into the customer experience.",
        demoKind: "usage-reporting",
      },
      {
        title: "Brandable AI Features",
        description:
          "Customer-facing AI functionality designed to fit the vendor product surface.",
        demoKind: "platform-embed",
      },
    ],
    secondarySectionTitle: "Custom Platform Extensions",
    secondarySectionDescription:
      "For vendors that need deeper integration and delivery support.",
    secondaryServices: [
      {
        title: "Custom Integrations",
        description:
          "Connect the AI layer to your CRM, billing, notifications, and operational systems.",
        demoKind: "platform-embed",
      },
      {
        title: "Provisioning Flows",
        description:
          "Customer onboarding, setup, permissions, and rollout logic that matches the platform model.",
        demoKind: "tenant-provisioning",
      },
      {
        title: "Usage Tracking",
        description:
          "Operational dashboards and reporting layers for customer usage and internal visibility.",
        demoKind: "usage-reporting",
      },
      {
        title: "Industry-Specific Features",
        description:
          "AI features shaped around the vendor customer base and market vertical.",
        demoKind: "platform-embed",
      },
      {
        title: "Launch Support",
        description:
          "Rollout support for pilots, launches, and expansion across customer segments.",
        demoKind: "tenant-provisioning",
      },
    ],
  },
  {
    slug: "franchises",
    title: "Franchises & Multi-Location",
    shortTitle: "Franchises",
    menuLabel: "Franchises",
    summary:
      "Location-aware AI systems and reporting for multi-branch operations.",
    examples: [
      "Retail Chains",
      "Restaurant Groups",
      "Service Networks",
    ],
    intro:
      "For multi-location businesses that need one customer communication system running consistently across branches.",
    icon: Store,
    readiness: "coming-soon",
    primarySectionTitle: "Core Rollout Areas",
    primarySectionDescription:
      "What this category is being shaped around.",
    primaryServices: [
      {
        title: "Location-Aware Booking",
        description: "Booking and enquiry flows that understand branches, territories, and service coverage.",
        demoKind: "coming-soon",
      },
      {
        title: "Shared Conversation Layer",
        description: "One conversation system with branch-specific routing and local execution.",
        demoKind: "coming-soon",
      },
      {
        title: "Cross-Location Reporting",
        description: "Operational visibility across locations from one reporting layer.",
        demoKind: "coming-soon",
      },
    ],
    secondarySectionTitle: "Status",
    secondarySectionDescription:
      "This category is being prepared for a fuller rollout.",
    secondaryServices: [
      {
        title: "Coming Soon",
        description: "Franchise-specific solution paths are being shaped around central control with local execution.",
        demoKind: "coming-soon",
      },
      {
        title: "Early Direction",
        description: "The main direction is one AI system deployed consistently across locations.",
        demoKind: "coming-soon",
      },
    ],
  },
];

export const solutionCategoryMap = Object.fromEntries(
  solutionCategories.map((category) => [category.slug, category]),
) as Record<string, SolutionCategory>;
