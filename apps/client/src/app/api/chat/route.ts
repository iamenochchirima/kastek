import { NextRequest, NextResponse } from "next/server";

const N8N_CHAT_WEBHOOK_URL =
  process.env.N8N_CHAT_WEBHOOK_URL ??
  "https://primary-production-738c.up.railway.app/webhook/a21d3f79-cfa7-44b1-b0e3-93ab1e51176d/chat";

function parseStreamedResponse(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed.output === "string") return parsed.output;
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
  } catch {
    // The n8n chat trigger can stream newline-delimited JSON payloads.
  }

  const contents: string[] = [];
  const regex = /"type"\s*:\s*"item"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    contents.push(
      match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\"),
    );
  }

  return contents.length > 0 ? contents.join("") : raw;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message?: string;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    };

    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const sessionId = body.sessionId?.trim() || crypto.randomUUID();

    const upstreamResponse = await fetch(N8N_CHAT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "sendMessage",
        sessionId,
        chatInput: message,
        metadata: body.metadata ?? {},
      }),
      cache: "no-store",
    });

    const raw = await upstreamResponse.text();
    const reply = parseStreamedResponse(raw).trim();

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        {
          error: "The assistant is currently unavailable.",
          details: reply || raw,
        },
        { status: upstreamResponse.status },
      );
    }

    return NextResponse.json({
      sessionId,
      reply,
    });
  } catch {
    return NextResponse.json(
      {
        error: "Something went wrong while contacting the assistant.",
      },
      { status: 500 },
    );
  }
}
