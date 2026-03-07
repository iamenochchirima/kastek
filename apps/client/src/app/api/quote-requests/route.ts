import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Resend } from "resend";
import {
  NotificationRecipientType,
  NotificationScopeType,
  NotificationSeverity,
  publishNotificationEvent,
} from "@kasitek/database";

const VALID_BUSINESS_TYPES = [
  "restaurant",
  "retail",
  "healthcare",
  "real_estate",
  "automotive",
  "professional_services",
  "salon_spa",
  "construction",
  "logistics",
  "other",
];

const VALID_SERVICES = [
  "website_presence",
  "website_chatbot",
  "whatsapp_chatbot",
  "bulk_whatsapp",
  "integrations_systems",
  "seo_optimization",
  "professional_email",
  "dashboard_analytics",
  "voice_agent",
  "custom_agent",
];

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      businessName,
      contactPerson,
      phone,
      email,
      businessType,
      services,
      description,
    } = body;

    if (
      !businessName ||
      !contactPerson ||
      !phone ||
      !email ||
      !businessType ||
      !services?.length
    ) {
      return NextResponse.json(
        { error: "All fields except description are required" },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address" },
        { status: 400 }
      );
    }

    if (!VALID_BUSINESS_TYPES.includes(businessType)) {
      return NextResponse.json(
        { error: "Invalid business type" },
        { status: 400 }
      );
    }

    const normalizedServices = Array.isArray(services)
      ? services
          .map((service: unknown) => String(service || "").trim())
          .filter(Boolean)
      : [];

    const hasInvalidService = normalizedServices.some((service: string) => {
      if (VALID_SERVICES.includes(service)) return false;
      // Allow custom typed services as plain text.
      return service.length > 120;
    });

    if (normalizedServices.length === 0 || hasInvalidService) {
      return NextResponse.json(
        { error: "Invalid service selection" },
        { status: 400 }
      );
    }

    const quoteRequest = await prisma.quoteRequest.create({
      data: {
        businessName,
        contactPerson,
        phone,
        email,
        businessType,
        services: normalizedServices,
        description: description || null,
      },
    });

    const adminRecipients = await prisma.adminUser.findMany({
      select: {
        id: true,
      },
    });

    if (adminRecipients.length > 0) {
      await publishNotificationEvent({
        scopeType: NotificationScopeType.ADMIN,
        scopeId: "global",
        eventType: "quote_request.created",
        title: "New quote request",
        message: `${businessName} submitted a new quote request for ${normalizedServices.length} service${
          normalizedServices.length === 1 ? "" : "s"
        }.`,
        severity: NotificationSeverity.SUCCESS,
        entityType: "quote_request",
        entityId: quoteRequest.id,
        payload: {
          businessName,
          contactPerson,
          phone,
          email,
          businessType,
          services: normalizedServices,
        },
        dedupeKey: `quote_request.created:${quoteRequest.id}`,
        recipients: adminRecipients.map((admin) => ({
          recipientType: NotificationRecipientType.ADMIN,
          recipientId: admin.id,
        })),
      });
    }

    const serviceLabels: Record<string, string> = {
      website_presence: "Website Development / Redesign",
      website_chatbot: "Website AI Agent",
      whatsapp_chatbot: "WhatsApp AI Agent",
      bulk_whatsapp: "Bulk WhatsApp Campaign System",
      integrations_systems: "Integrations & Payment Systems",
      seo_optimization: "SEO Optimization",
      professional_email: "Professional Email Setup",
      dashboard_analytics: "Custom Dashboards & Analytics",
      voice_agent: "AI Voice Agent",
      custom_agent: "Custom AI / Automation",
    };

    try {
      const resend = new Resend(process.env.AUTH_RESEND_KEY);
      await resend.emails.send({
        from: "KasiTek <onboarding@resend.dev>",
        to: process.env.ADMIN_EMAIL || "iamenochchirima@gmail.com",
        subject: `New Quote Request: ${businessName}`,
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color: #c4f04d; background: #0a0a0a; padding: 16px; border-radius: 12px;">
              New Quote Request
            </h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #888;">Business</td><td style="padding: 8px 0;">${businessName}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Contact</td><td style="padding: 8px 0;">${contactPerson}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Phone</td><td style="padding: 8px 0;">${phone}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Email</td><td style="padding: 8px 0;">${email}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Type</td><td style="padding: 8px 0;">${businessType.replace(/_/g, " ")}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Services</td><td style="padding: 8px 0;">${normalizedServices.map((s: string) => serviceLabels[s] || s).join(", ")}</td></tr>
              ${description ? `<tr><td style="padding: 8px 0; color: #888; vertical-align: top;">Description</td><td style="padding: 8px 0;">${description}</td></tr>` : ""}
            </table>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Failed to send admin notification:", emailError);
    }

    return NextResponse.json(
      { message: "Quote request submitted successfully", id: quoteRequest.id },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
