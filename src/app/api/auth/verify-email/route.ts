import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const email = searchParams.get("email");

  if (!token || !email) {
    return NextResponse.redirect(
      new URL("/auth-error?error=InvalidToken", process.env.AUTH_URL!)
    );
  }

  const verificationToken = await prisma.verificationToken.findFirst({
    where: {
      identifier: email,
      token,
    },
  });

  if (!verificationToken || verificationToken.expires < new Date()) {
    return NextResponse.redirect(
      new URL("/auth-error?error=ExpiredToken", process.env.AUTH_URL!)
    );
  }

  // Mark user as verified
  await prisma.user.update({
    where: { email },
    data: { emailVerified: new Date() },
  });

  // Delete used token
  await prisma.verificationToken.delete({
    where: {
      identifier_token: {
        identifier: email,
        token,
      },
    },
  });

  // Redirect to login with success message
  return NextResponse.redirect(
    new URL("/login?verified=true", process.env.AUTH_URL!)
  );
}
