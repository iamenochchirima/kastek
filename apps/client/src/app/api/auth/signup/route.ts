import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Resend } from "resend";

export async function POST(req: Request) {
  try {
    const { email, password, name, phone, phoneVerified } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    if (phone && !phoneVerified) {
      return NextResponse.json(
        { error: "Phone number must be verified" },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: { accounts: true },
    });

    if (existingUser) {
      const hasGoogleAccount = existingUser.accounts.some(
        (a) => a.provider === "google"
      );

      if (hasGoogleAccount && !existingUser.password) {
        // Google-only user wants to add email/password login
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

        return NextResponse.json(
          {
            error:
              "An account with this email is linked to Google. Check your email to set up a password.",
            code: "GOOGLE_ACCOUNT_EXISTS",
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        name: name || null,
        password: hashedPassword,
        phone: phone || null,
      },
    });

    // Generate verification token
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await prisma.verificationToken.create({
      data: {
        identifier: email,
        token,
        expires,
      },
    });

    // Send verification email
    const resend = new Resend(process.env.AUTH_RESEND_KEY);
    const verifyUrl = `${process.env.AUTH_URL}/api/auth/verify-email?token=${token}&email=${encodeURIComponent(email)}`;

    await resend.emails.send({
      from: "KasiTek <onboarding@resend.dev>",
      to: email,
      subject: "Verify your KasiTek account",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Welcome to KasiTek</h2>
          <p>Click the button below to verify your email address.</p>
          <a href="${verifyUrl}" style="display: inline-block; background: #c4f04d; color: #0a0a0a; padding: 12px 24px; border-radius: 100px; text-decoration: none; font-weight: 600;">
            Verify Email
          </a>
          <p style="color: #888; font-size: 14px; margin-top: 24px;">
            This link expires in 24 hours. If you didn't create this account, you can ignore this email.
          </p>
        </div>
      `,
    });

    return NextResponse.json({
      message: "Account created. Check your email to verify.",
      userId: user.id,
    });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
