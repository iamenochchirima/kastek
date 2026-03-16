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

const VALID_PRODUCTS = [
  "kasitek_product_basic",
  "kasitek_product_growth",
  "kasitek_product_scale",
  "kasiagents",
  "kasireach",
  "kasisocial",
];

const productLabels: Record<string, string> = {
  kasitek_product_basic: "KasiTek Basic Plan",
  kasitek_product_growth: "KasiTek Growth Plan",
  kasitek_product_scale: "KasiTek Scale Plan",
  kasiagents: "KasiAgents",
  kasireach: "KasiReach",
  kasisocial: "KasiSocial",
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      businessName,
      contactPerson,
      phone,
      email,
      businessType,
      products,
      notes,
    } = body;

    if (!businessName || !contactPerson || !email || !products?.length) {
      return NextResponse.json(
        { error: "Business name, contact person, email, and at least one product are required" },
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

    if (businessType && !VALID_BUSINESS_TYPES.includes(businessType)) {
      return NextResponse.json(
        { error: "Invalid business type" },
        { status: 400 }
      );
    }

    const normalizedProducts = Array.isArray(products)
      ? products.map((product: unknown) => String(product || "").trim()).filter(Boolean)
      : [];

    const hasInvalidProduct = normalizedProducts.some(
      (product: string) => !VALID_PRODUCTS.includes(product)
    );

    if (normalizedProducts.length === 0 || hasInvalidProduct) {
      return NextResponse.json(
        { error: "Invalid product selection" },
        { status: 400 }
      );
    }

    const waitlistEntry = await prisma.productWaitlistEntry.create({
      data: {
        businessName,
        contactPerson,
        phone: phone || null,
        email,
        businessType: businessType || null,
        products: normalizedProducts,
        notes: notes || null,
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
        eventType: "product_waitlist.created",
        title: "New product waitlist signup",
        message: `${businessName} joined the waitlist for ${normalizedProducts
          .map((product) => productLabels[product] || product)
          .join(", ")}.`,
        severity: NotificationSeverity.SUCCESS,
        entityType: "product_waitlist_entry",
        entityId: waitlistEntry.id,
        payload: {
          businessName,
          contactPerson,
          phone,
          email,
          businessType,
          products: normalizedProducts,
        },
        dedupeKey: `product_waitlist.created:${waitlistEntry.id}`,
        recipients: adminRecipients.map((admin) => ({
          recipientType: NotificationRecipientType.ADMIN,
          recipientId: admin.id,
        })),
      });
    }

    try {
      const resend = new Resend(process.env.AUTH_RESEND_KEY);
      await resend.emails.send({
        from: "KasiTek <onboarding@resend.dev>",
        to: process.env.ADMIN_EMAIL || "iamenochchirima@gmail.com",
        subject: `New Product Waitlist Signup: ${businessName}`,
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color: #e8a020; background: #0a0a0a; padding: 16px; border-radius: 12px;">
              New Product Waitlist Signup
            </h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #888;">Business</td><td style="padding: 8px 0;">${businessName}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Contact</td><td style="padding: 8px 0;">${contactPerson}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Phone</td><td style="padding: 8px 0;">${phone || "-"}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Email</td><td style="padding: 8px 0;">${email}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Type</td><td style="padding: 8px 0;">${businessType ? businessType.replace(/_/g, " ") : "-"}</td></tr>
              <tr><td style="padding: 8px 0; color: #888;">Products</td><td style="padding: 8px 0;">${normalizedProducts.map((product) => productLabels[product] || product).join(", ")}</td></tr>
              ${notes ? `<tr><td style="padding: 8px 0; color: #888; vertical-align: top;">Notes</td><td style="padding: 8px 0;">${notes}</td></tr>` : ""}
            </table>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Failed to send admin waitlist notification:", emailError);
    }

    return NextResponse.json(
      { message: "Waitlist signup submitted successfully", id: waitlistEntry.id },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
