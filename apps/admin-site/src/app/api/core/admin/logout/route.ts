import {operationsAuthProxy} from "@/lib/operations-api";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const CORE_BACKEND_URL = process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

export async function POST(req: Request) {
  if(process.env.OPS_BACKEND_URL)return operationsAuthProxy(req,"logout");
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);

  if (sessionCookie?.value) {
    const revoked = await fetch(`${CORE_BACKEND_URL}/api/admin/logout`, {
      method: "POST",
      headers: {
        Origin: process.env.ADMIN_FRONTEND_URL ?? "http://localhost:3001",
        Cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`,
      },
    }).catch(() => null);
    if (!revoked?.ok) return NextResponse.json({error: "Unable to revoke session"}, {status: 503});
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ADMIN_SESSION_COOKIE);
  return response;
}
