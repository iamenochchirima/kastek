import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createWhatsappTemplate, toWhatsappTemplateErrorMessage } from "@/lib/whatsapp/template-service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      connectionId?: string;
      templateName?: string;
      language?: string;
      category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
      header?: string;
      body?: string;
      footer?: string;
    };

    const result = await createWhatsappTemplate({
      userId,
      connectionId: body.connectionId || "",
      templateName: body.templateName || "",
      language: body.language || "",
      category: body.category || "MARKETING",
      header: body.header,
      body: body.body || "",
      footer: body.footer,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = toWhatsappTemplateErrorMessage(error);
    console.error("POST /api/whatsapp/templates failed", {
      error,
      message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
