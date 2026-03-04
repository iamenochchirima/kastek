import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { NextResponse } from "next/server";
import { Resend } from "resend";

function buildEmailChangeIdentifier(userId: string, nextEmail: string) {
  return `profile-email-change|${userId}|${encodeURIComponent(nextEmail)}`;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const nextEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!nextEmail) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(nextEmail)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      email: true,
    },
  });

  if (!currentUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (currentUser.email?.toLowerCase() === nextEmail) {
    return NextResponse.json(
      { error: "That is already your current email address" },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: nextEmail },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: "An account with that email already exists" },
      { status: 409 }
    );
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const identifier = buildEmailChangeIdentifier(session.user.id, nextEmail);

  await prisma.verificationToken.deleteMany({
    where: {
      identifier: {
        startsWith: `profile-email-change|${session.user.id}|`,
      },
    },
  });

  await prisma.verificationToken.create({
    data: {
      identifier,
      token,
      expires,
    },
  });

  const resend = new Resend(process.env.AUTH_RESEND_KEY);
  const verifyUrl = `${process.env.AUTH_URL}/api/profile/email/verify?token=${token}&change=${encodeURIComponent(identifier)}`;

  await resend.emails.send({
    from: "KasiTek <onboarding@resend.dev>",
    to: nextEmail,
    subject: "Confirm your new KasiTek email address",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Confirm your new email address</h2>
        <p>Click the button below to confirm this email address for your KasiTek account.</p>
        <a href="${verifyUrl}" style="display: inline-block; background: #c4f04d; color: #0a0a0a; padding: 12px 24px; border-radius: 100px; text-decoration: none; font-weight: 600;">
          Confirm Email Change
        </a>
        <p style="color: #888; font-size: 14px; margin-top: 24px;">
          This link expires in 24 hours. If you didn't request this change, you can ignore this email.
        </p>
      </div>
    `,
  });

  return NextResponse.json({
    message: "Verification link sent. Open it from your new email to complete the change.",
  });
}
