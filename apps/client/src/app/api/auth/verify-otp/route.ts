import { NextResponse } from "next/server";
import { verifyOTP } from "@/lib/sms";

export async function POST(req: Request) {
  try {
    const { phone, code } = await req.json();

    if (!phone || !code) {
      return NextResponse.json(
        { error: "Phone number and code are required" },
        { status: 400 }
      );
    }

    const approved = await verifyOTP(phone, code);

    if (!approved) {
      return NextResponse.json(
        { error: "Invalid or expired code. Please try again." },
        { status: 400 }
      );
    }

    return NextResponse.json({ verified: true });
  } catch {
    return NextResponse.json(
      { error: "Verification failed. Please try again." },
      { status: 500 }
    );
  }
}
