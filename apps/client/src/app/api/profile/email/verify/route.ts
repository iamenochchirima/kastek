import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

function parseEmailChangeIdentifier(identifier: string) {
  const [prefix, userId, encodedEmail] = identifier.split("|");
  if (prefix !== "profile-email-change" || !userId || !encodedEmail) {
    return null;
  }

  return {
    userId,
    nextEmail: decodeURIComponent(encodedEmail),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const change = searchParams.get("change");

  if (!token || !change) {
    return NextResponse.redirect(
      new URL("/auth-error?error=InvalidToken", process.env.AUTH_URL!)
    );
  }

  const verificationToken = await prisma.verificationToken.findFirst({
    where: {
      identifier: change,
      token,
    },
  });

  if (!verificationToken || verificationToken.expires < new Date()) {
    return NextResponse.redirect(
      new URL("/auth-error?error=ExpiredToken", process.env.AUTH_URL!)
    );
  }

  const parsed = parseEmailChangeIdentifier(change);
  if (!parsed) {
    return NextResponse.redirect(
      new URL("/auth-error?error=InvalidToken", process.env.AUTH_URL!)
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: parsed.nextEmail },
    select: { id: true },
  });

  if (existing) {
    await prisma.verificationToken.delete({
      where: {
        identifier_token: {
          identifier: change,
          token,
        },
      },
    });

    return NextResponse.redirect(
      new URL("/dashboard/profile?emailChange=conflict", process.env.AUTH_URL!)
    );
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: parsed.userId },
      data: {
        email: parsed.nextEmail,
        emailVerified: new Date(),
      },
    }),
    prisma.verificationToken.delete({
      where: {
        identifier_token: {
          identifier: change,
          token,
        },
      },
    }),
  ]);

  return NextResponse.redirect(
    new URL("/dashboard/profile?emailChange=success", process.env.AUTH_URL!)
  );
}
