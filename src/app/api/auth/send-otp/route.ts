import { NextResponse } from "next/server";
import { sendOTP } from "@/lib/sms";

export async function POST(req: Request) {
  try {
    const { phone } = await req.json();

    if (!phone) {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      );
    }

    await sendOTP(phone);

    return NextResponse.json({ message: "OTP sent" });
  } catch (err) {
    console.error("send-otp error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to send verification code: ${message}` },
      { status: 500 }
    );
  }
}
