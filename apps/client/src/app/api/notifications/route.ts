import { auth } from "@/auth";
import {
  NotificationRecipientType,
  listNotificationInbox,
  markAllNotificationsAsRead,
} from "@kasiai/database";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Number.parseInt(searchParams.get("limit") || "20", 10);
  const cursor = searchParams.get("cursor") || undefined;

  const inbox = await listNotificationInbox(
    NotificationRecipientType.USER,
    session.user.id,
    {
      limit: Number.isNaN(limit) ? 20 : Math.min(Math.max(limit, 1), 100),
      cursor,
    }
  );

  return NextResponse.json(inbox);
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
    NotificationRecipientType.USER,
    session.user.id
  );

  return NextResponse.json({ updated: result.count });
}
