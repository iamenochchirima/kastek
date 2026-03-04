import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { updateWhatsappConnectionAccessToken } from "@/lib/whatsapp/onboarding-service";

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
    const body = (await req.json()) as {
      accessToken?: string;
    };

    const result = await updateWhatsappConnectionAccessToken(
      userId,
      id,
      body.accessToken || ""
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update access token";
    const status = message.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
