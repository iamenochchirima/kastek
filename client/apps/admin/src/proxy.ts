import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const CORE_BACKEND_URL =
  process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

const PUBLIC_PATHS = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/api/",
  "/favicon.ico",
  "/icon.svg",
  "/logo.png",
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths through without auth check
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get(ADMIN_SESSION_COOKIE);
  if (!sessionCookie?.value) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const res = await fetch(`${CORE_BACKEND_URL}/api/admin/me`, {
      headers: {
        Cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`,
      },
    });

    if (!res.ok) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
