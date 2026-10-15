import { NextResponse } from "next/server";
import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";
import { sendSmtpMail, verifySmtpTransport } from "@/lib/smtp";

async function ensureTestCampaignId(): Promise<string> {
  const res = await fetchFromCore("/api/admin/outreach");
  const campaigns = res.ok ? (await res.json() as Array<{ id: string; name: string; category: string }>) : [];
  const existing = Array.isArray(campaigns)
    ? campaigns.find((c) => c.name === "System Test Sends" && c.category === "system-test")
    : null;

  if (existing?.id) return existing.id;

  const createRes = await fetchFromCore("/api/admin/outreach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "System Test Sends", category: "system-test", status: "active" }),
  });
  const created = await createRes.json() as { id: string };
  return created.id;
}

export async function POST(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const to = String(body?.to || admin.email || "").trim();
  const subject = String(body?.subject || "").trim();
  const text = String(body?.text || body?.emailBody || "").trim();
  const html = body?.html ? String(body.html) : undefined;

  try {
    if (!to) {
      return NextResponse.json(
        { error: "No recipient provided and session user has no email" },
        { status: 400 }
      );
    }

    if (!subject || !text) {
      return NextResponse.json(
        { error: "Test send requires draft subject and full draft body" },
        { status: 400 }
      );
    }

    await verifySmtpTransport();

    const info = await sendSmtpMail({ to, subject, text, html });
    const testCampaignId = await ensureTestCampaignId();

    let logSaved = true;
    let logError: string | null = null;
    try {
      await fetchFromCore("/api/admin/outreach/delivery-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logs: [{
            campaignId: testCampaignId,
            leadId: null,
            recipient: to.toLowerCase(),
            subject,
            status: "sent",
            provider: "smtp",
            providerMessageId: info.messageId ? String(info.messageId) : null,
            providerResponse: info.response ? String(info.response) : null,
          }],
        }),
      });
    } catch (e) {
      logSaved = false;
      logError = e instanceof Error ? e.message : "Unknown log write error";
      console.error("[outreach test send] log write failed:", logError);
    }

    return NextResponse.json({
      ok: true,
      to,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      logSaved,
      logError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMTP test failed";
    if (to) {
      try {
        const testCampaignId = await ensureTestCampaignId();
        await fetchFromCore("/api/admin/outreach/delivery-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logs: [{
              campaignId: testCampaignId,
              leadId: null,
              recipient: to.toLowerCase(),
              subject,
              status: "failed",
              provider: "smtp",
              errorMessage: message,
            }],
          }),
        });
      } catch (e) {
        console.error(
          "[outreach test send] failed-log write failed:",
          e instanceof Error ? e.message : "Unknown log write error"
        );
      }
    }
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
