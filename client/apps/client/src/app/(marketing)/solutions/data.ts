import {
  BriefcaseBusiness,
  Building2,
  Layers3,
  Store,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
  primaryItems: string[];
  secondarySectionTitle: string;
  secondarySectionDescription: string;
  secondaryItems: string[];
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
    primaryItems: [
      "Website agents for live enquiries, lead capture, and instant responses",
      "WhatsApp agents for FAQs, bookings, order support, and customer conversations",
      "WhatsApp catalogue journeys for product discovery, browsing, and ordering",
      "Bulk campaign tools for outreach, announcements, and repeat customer engagement",
      "Content and creative workflows for posts, offers, and campaign assets",
    ],
    secondarySectionTitle: "Custom Services",
    secondarySectionDescription:
      "Built around the way your business actually runs.",
    secondaryItems: [
      "Booking and appointment systems connected to your real workflow",
      "Automated quotation creation for qualifying jobs and service requests",
      "Voice agents for after-hours calls, triage, and call routing",
      "Lead nurturing, reminder, and review automation flows",
      "Custom dashboards, reporting, and business-specific integrations",
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
    primaryItems: [
      "Conversational lead generation across website, WhatsApp, Instagram, and voice",
      "Lead nurturing, reminder, and review automation for client retention",
      "Content and creative engines for blogs, social, ad copy, and AEO content",
      "Branded reporting dashboards for client visibility and proof of work",
      "Voice agent and quotation workflows as recurring service add-ons",
    ],
    secondarySectionTitle: "Custom Partner Builds",
    secondarySectionDescription:
      "For agencies that need deeper delivery support or unique service models.",
    secondaryItems: [
      "Client-specific workflows, handoff rules, and onboarding flows",
      "Branded portals, dashboards, and reporting experiences",
      "Custom campaign automations tied to the agency delivery model",
      "Industry-specific packaged solutions for healthcare, home services, retail, and more",
      "Operational support for rollout, optimisation, and recurring delivery",
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
    primaryItems: [
      "Embedded conversation agents for websites, messaging, and support channels",
      "Lead nurturing and conversion workflows tied to product events and customer activity",
      "Content and creative engines that complement existing marketing modules",
      "Reporting surfaces for customer usage, campaign performance, and outcomes",
      "Brandable customer-facing AI features that fit the product experience",
    ],
    secondarySectionTitle: "Custom Platform Extensions",
    secondarySectionDescription:
      "For vendors that need deeper integration and delivery support.",
    secondaryItems: [
      "Custom integrations with your platform, CRM, billing, or notification systems",
      "Tenant-aware workflows, provisioning flows, and permission-aware experiences",
      "Usage tracking, reporting layers, and operational dashboards",
      "Industry-specific AI features built around your customer base",
      "Partner-facing rollout support for launches, pilots, and expansion",
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
    primaryItems: [
      "Location-aware booking and enquiry flows",
      "Shared conversation systems with branch-specific routing",
      "Cross-location reporting and operational visibility",
    ],
    secondarySectionTitle: "Status",
    secondarySectionDescription:
      "This category is being prepared for a fuller rollout.",
    secondaryItems: [
      "Franchise-specific solution paths are coming soon",
      "The main direction is central control with local execution",
    ],
  },
];

export const solutionCategoryMap = Object.fromEntries(
  solutionCategories.map((category) => [category.slug, category]),
) as Record<string, SolutionCategory>;
