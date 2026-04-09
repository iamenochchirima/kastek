import nodemailer from "nodemailer";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getSmtpTransport() {
  const host = requiredEnv("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || "465");
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
  const user = requiredEnv("SMTP_USER");
  const pass = requiredEnv("SMTP_PASS");

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

export async function verifySmtpTransport() {
  const transporter = getSmtpTransport();
  await transporter.verify();
  return true;
}

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendSmtpMail(input: SendMailInput) {
  const transporter = getSmtpTransport();
  const from = process.env.SMTP_FROM || requiredEnv("SMTP_USER");

  const info = await transporter.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  });

  return info;
}
