import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

export function middleware(request: NextRequest) {
  const token =
    request.cookies.get(ADMIN_SESSION_COOKIE) ||
    request.cookies.get("authjs.session-token") ||
    request.cookies.get("__Secure-authjs.session-token");

  const { pathname } = request.nextUrl;

  const isProtectedRoute =
    pathname === "/" ||
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/leads") ||
    pathname.startsWith("/quotations") ||
    pathname.startsWith("/invoices") ||
    pathname.startsWith("/conversations") ||
    pathname.startsWith("/outreach") ||
    pathname.startsWith("/web-services") ||
    pathname.startsWith("/agencies");
  const isAuthRoute = pathname === "/login";

  if (isProtectedRoute && !token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (isAuthRoute && token) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
