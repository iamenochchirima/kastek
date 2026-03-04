import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { Resend } from "resend";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { accounts: true },
    });

    if (!user) {
      // Don't reveal whether account exists — show same success message
      return NextResponse.json({
        message: "If an account exists with that email, we've sent a password setup link.",
      });
    }

    const hasGoogleAccount = user.accounts.some(
      (a) => a.provider === "google"
    );

    if (!hasGoogleAccount) {
      // Not a Google account — same generic message
      return NextResponse.json({
        message: "If an account exists with that email, we've sent a password setup link.",
      });
    }

    if (user.password) {
      // Already has a password — same generic message
      return NextResponse.json({
        message: "If an account exists with that email, we've sent a password setup link.",
      });
    }

    // Google-only user — send the setup email
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.deleteMany({
      where: { identifier: email },
    });

    await prisma.verificationToken.create({
      data: { identifier: email, token, expires },
    });

    const resend = new Resend(process.env.AUTH_RESEND_KEY);
    const setupUrl = `${process.env.AUTH_URL}/set-password?token=${token}&email=${encodeURIComponent(email)}`;

    await resend.emails.send({
      from: "KasiTek <onboarding@resend.dev>",
      to: email,
      subject: "Set up a password for your KasiTek account",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Set Up a Password</h2>
          <p>You already have a KasiTek account linked to Google. Click the button below to set up a password so you can sign in with either method.</p>
          <a href="${setupUrl}" style="display: inline-block; background: #c4f04d; color: #0a0a0a; padding: 12px 24px; border-radius: 100px; text-decoration: none; font-weight: 600;">
            Set Password
          </a>
          <p style="color: #888; font-size: 14px; margin-top: 24px;">
            This link expires in 24 hours. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    return NextResponse.json({
      message: "If an account exists with that email, we've sent a password setup link.",
    });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
