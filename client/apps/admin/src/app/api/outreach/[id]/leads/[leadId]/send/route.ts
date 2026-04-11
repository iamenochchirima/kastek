import { NextResponse } from "next/server";
import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";
import { sendSmtpMail, verifySmtpTransport } from "@/lib/smtp";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; leadId: string }> }
) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: campaignId, leadId } = await params;

  // Fetch lead from Rust
  const leadRes = await fetchFromCore(`/api/admin/outreach/${campaignId}/leads/${leadId}`);
  if (!leadRes.ok) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }
  const lead = await leadRes.json() as {
    id: string;
    campaignId: string;
    emailAddress: string | null;
    notes: string | null;
  };

  const body = await req.json();
  const rawTo = body.to;
  const toList = Array.isArray(rawTo)
    ? rawTo.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean)
    : String(rawTo || "").trim()
      ? [String(rawTo).trim().toLowerCase()]
      : [];
  const fallbackLeadEmail = String(lead.emailAddress || "").trim();
  const to = Array.from(new Set(toList.length ? toList : fallbackLeadEmail ? [fallbackLeadEmail.toLowerCase()] : []));
  const primaryTo = String(body.primaryTo || to[0] || "").trim();
  const subject = String(body.subject || "").trim();
  const emailText = String(body.text || body.emailBody || "").trim();
  const emailHtml = body.html ? String(body.html) : undefined;

  if (!to.length) {
    return NextResponse.json({ error: "Lead has no email address" }, { status: 400 });
  }
  if (!subject || !emailText) {
    return NextResponse.json(
      { error: "subject and text/emailBody are required" },
      { status: 400 }
    );
  }

  try {
    await verifySmtpTransport();
    const info = await sendSmtpMail({
      to: to.join(", "),
      subject,
      text: emailText,
      ...(emailHtml ? { html: emailHtml } : {}),
    });

    const rejectedSet = new Set(
      (info.rejected || []).map((entry: unknown) => String(entry || "").trim().toLowerCase())
    );

    // Update lead status via Rust
    const patchRes = await fetchFromCore(`/api/admin/outreach/${campaignId}/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emailStatus: "sent",
        emailSentAt: new Date().toISOString(),
        emailAddress: primaryTo || to[0] || null,
        emailTemplate: emailText,
      }),
    });
    const updatedLead = await patchRes.json();

    // Create delivery logs via Rust
    if (to.length > 0) {
      await fetchFromCore("/api/admin/outreach/delivery-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logs: to.map((recipient) => ({
            campaignId,
            leadId,
            recipient,
            subject,
            status: rejectedSet.has(recipient) ? "failed" : "sent",
            provider: "smtp",
            providerMessageId: info.messageId ? String(info.messageId) : null,
            providerResponse: info.response ? String(info.response) : null,
            errorMessage: rejectedSet.has(recipient) ? "Rejected by SMTP provider" : null,
          })),
        }),
      });
    }

    return NextResponse.json({
      ok: true,
      lead: updatedLead,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Send failed";

    // Update lead status back to pending
    const existingNotes = (lead.notes || "");
    await fetchFromCore(`/api/admin/outreach/${campaignId}/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emailStatus: "pending",
        notes: [existingNotes, `Send failed: ${message}`].filter(Boolean).join("\n"),
      }),
    });

    if (to.length > 0) {
      await fetchFromCore("/api/admin/outreach/delivery-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logs: to.map((recipient) => ({
            campaignId,
            leadId,
            recipient,
            subject,
            status: "failed",
            provider: "smtp",
            errorMessage: message,
          })),
        }),
      });
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
