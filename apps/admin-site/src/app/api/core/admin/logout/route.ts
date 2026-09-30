import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const CORE_BACKEND_URL = process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);

  if (sessionCookie?.value) {
    await fetch(`${CORE_BACKEND_URL}/api/admin/logout`, {
      method: "POST",
      headers: {
        Cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`,
      },
    }).catch(() => {});
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ADMIN_SESSION_COOKIE);
  return response;
}
