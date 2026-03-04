import { auth } from "@/auth";
import { NotificationRecipientType, markNotificationAsRead } from "@kasitek/database";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await markNotificationAsRead(
    NotificationRecipientType.ADMIN,
    session.user.id,
    id
  );

  if (result.count === 0) {
    return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  }

  return NextResponse.json({ updated: result.count });
}
