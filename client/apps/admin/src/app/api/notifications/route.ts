import { auth } from "@/auth";
import {
  NotificationChannel,
  NotificationRecipientType,
  listNotifications,
  markAllNotificationsAsRead,
} from "@kasitek/database";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const unreadOnly = searchParams.get("unreadOnly") === "true";
  const limit = Number.parseInt(searchParams.get("limit") || "20", 10);
  const channelParam = searchParams.get("channel");
  const channel =
    channelParam === NotificationChannel.EMAIL || channelParam === NotificationChannel.IN_APP
      ? channelParam
      : undefined;

  const notifications = await listNotifications(
    NotificationRecipientType.ADMIN,
    session.user.id,
    {
      channel,
      unreadOnly,
      limit: Number.isNaN(limit) ? 20 : Math.min(Math.max(limit, 1), 100),
    }
  );

  return NextResponse.json({ notifications });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
  };

  if (body.action !== "mark_all_read") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  const result = await markAllNotificationsAsRead(
    NotificationRecipientType.ADMIN,
    session.user.id
  );

  return NextResponse.json({ updated: result.count });
}
