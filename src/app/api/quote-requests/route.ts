import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Resend } from "resend";

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

const VALID_SERVICES = ["whatsapp_chatbot", "voice_agent", "website_chatbot", "custom_agent"];

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

    if (
      !Array.isArray(services) ||
      !services.every((s: string) => VALID_SERVICES.includes(s))
    ) {
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
        services,
        description: description || null,
      },
    });

    const serviceLabels: Record<string, string> = {
      whatsapp_chatbot: "WhatsApp Chatbot",
      voice_agent: "AI Voice Agent",
      website_chatbot: "Website Chatbot",
      custom_agent: "Custom AI Agent",
    };

    try {
      const resend = new Resend(process.env.AUTH_RESEND_KEY);
      await resend.emails.send({
        from: "KasiAI <onboarding@resend.dev>",
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
              <tr><td style="padding: 8px 0; color: #888;">Services</td><td style="padding: 8px 0;">${services.map((s: string) => serviceLabels[s] || s).join(", ")}</td></tr>
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
