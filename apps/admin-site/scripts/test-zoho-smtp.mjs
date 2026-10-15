import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nodemailer = require("nodemailer");

function loadEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return;
  const raw = fs.readFileSync(abs, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(".env.local");

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || "465");
const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (!host || !user || !pass) {
  console.error("Missing SMTP_HOST/SMTP_USER/SMTP_PASS in .env.local");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
});

await transporter.verify();
console.log("SMTP verify OK");

const argTo = process.argv.find((x) => x.startsWith("--to="));
if (argTo) {
  const to = argTo.replace("--to=", "");
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || user,
    to,
    subject: "KasiTek SMTP test",
    text: "SMTP send test from KasiTek admin.",
    html: "<p>SMTP send test from <strong>KasiTek admin</strong>.</p>",
  });
  console.log("Sent OK", {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  });
}
