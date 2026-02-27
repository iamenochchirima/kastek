import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getConnectionHealth } from "@/lib/whatsapp/connection-health";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const health = await getConnectionHealth(userId, id);

    return NextResponse.json(health, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Health check failed";
    const status = message.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
