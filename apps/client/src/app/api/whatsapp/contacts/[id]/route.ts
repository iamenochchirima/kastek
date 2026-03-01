import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { normalizeToE164 } from "@/lib/whatsapp/phone";

export const runtime = "nodejs";

type UpdateContactBody = {
  fullName?: string | null;
  phone?: string;
  location?: string | null;
  tags?: string[];
  notes?: string | null;
  optIn?: boolean;
  excluded?: boolean;
};

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = (await req.json()) as UpdateContactBody;

    const existing = await prisma.whatsappContact.findFirst({
      where: {
        id,
        userId,
      },
      select: {
        id: true,
        optInDate: true,
      },
    });

    if (!existing) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    let normalizedPhone: string | undefined;
    if (typeof body.phone === "string") {
      const parsedPhone = normalizeToE164(body.phone);
      if (!parsedPhone) {
        return NextResponse.json({ error: "Invalid phone number format" }, { status: 400 });
      }
      normalizedPhone = parsedPhone;
    }

    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => tag.trim()).filter(Boolean)
      : undefined;

    const contact = await prisma.whatsappContact.update({
      where: { id },
      data: {
        fullName:
          body.fullName === undefined ? undefined : body.fullName?.trim() || null,
        phone: normalizedPhone,
        location:
          body.location === undefined ? undefined : body.location?.trim() || null,
        tags,
        notes: body.notes === undefined ? undefined : body.notes?.trim() || null,
        optIn: body.optIn,
        excluded: body.excluded,
        optInDate:
          body.optIn === undefined
            ? undefined
            : body.optIn
              ? existing.optInDate || new Date()
              : null,
      },
    });

    return NextResponse.json({ contact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update contact";
    const status = message.includes("Unique constraint") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
