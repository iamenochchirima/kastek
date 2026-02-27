import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { launchWhatsappCampaign } from "@/lib/whatsapp/campaign-service";

export const runtime = "nodejs";

export async function POST(
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
    const body = (await req.json().catch(() => ({}))) as { scheduledAt?: string };

    const result = await launchWhatsappCampaign(userId, id, {
      scheduledAt: body.scheduledAt || null,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      const status =
        error.message.includes("not found")
          ? 404
          : error.message.includes("exceeds estimated daily portfolio limit")
            ? 409
            : 400;

      return NextResponse.json({ error: error.message }, { status });
    }

    return NextResponse.json(
      { error: "Failed to launch campaign" },
      { status: 500 }
    );
  }
}
