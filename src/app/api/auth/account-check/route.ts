import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();

    if (!email) {
      return NextResponse.json({ provider: null });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        password: true,
        accounts: { select: { provider: true } },
      },
    });

    if (!user) {
      return NextResponse.json({ provider: null });
    }

    const hasGoogle = user.accounts.some((a) => a.provider === "google");
    const hasPassword = !!user.password;

    if (hasGoogle && hasPassword) {
      return NextResponse.json({ provider: "both" });
    } else if (hasGoogle) {
      return NextResponse.json({ provider: "google" });
    } else {
      return NextResponse.json({ provider: "credentials" });
    }
  } catch {
    return NextResponse.json({ provider: null });
  }
}
