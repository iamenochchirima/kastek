import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID!;

export async function sendOTP(phone: string) {
  const verification = await client.verify.v2
    .services(verifyServiceSid)
    .verifications.create({ to: phone, channel: "sms" });

  return verification.status;
}

export async function verifyOTP(phone: string, code: string) {
  const check = await client.verify.v2
    .services(verifyServiceSid)
    .verificationChecks.create({ to: phone, code });

  return check.status === "approved";
}
