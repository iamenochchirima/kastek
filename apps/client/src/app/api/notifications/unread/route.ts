import { auth } from "@/auth";
import { NotificationRecipientType, getUnreadNotificationCount } from "@kasitek/database";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const unreadCount = await getUnreadNotificationCount(
    NotificationRecipientType.USER,
    session.user.id
  );

  return NextResponse.json({ unreadCount });
}
