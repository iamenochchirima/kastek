import { prisma } from "@/lib/prisma";
import crypto from "crypto";

const ZOOMCONNECT_SEND_URL = process.env.ZOOMCONNECT_SEND_URL!;

function generateOTP(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Send an SMS via ZoomConnect (SMS Messenger) URL API.
 * For production, swap to Twilio by changing the provider below.
 */
async function sendSMS(phone: string, message: string) {
  const url = `${ZOOMCONNECT_SEND_URL}.txt?recipientNumber=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}`;

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SMS send failed: ${text}`);
  }

  return res.text();
}

export async function sendOTP(phone: string) {
  const code = generateOTP();
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Clean up existing OTPs for this phone
  await prisma.verificationToken.deleteMany({
    where: { identifier: `phone:${phone}` },
  });

  // Store the OTP
  await prisma.verificationToken.create({
    data: {
      identifier: `phone:${phone}`,
      token: code,
      expires,
    },
  });

  await sendSMS(phone, `Your KasiAI verification code is: ${code}`);
}

export async function verifyOTP(phone: string, code: string): Promise<boolean> {
  const token = await prisma.verificationToken.findFirst({
    where: { identifier: `phone:${phone}`, token: code },
  });

  if (!token || token.expires < new Date()) {
    return false;
  }

  // Delete used token
  await prisma.verificationToken.delete({
    where: {
      identifier_token: { identifier: `phone:${phone}`, token: code },
    },
  });

  return true;
}
