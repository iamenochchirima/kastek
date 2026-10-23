import {adminSessionTransport,loadAdminActor} from "@/lib/admin-session-transport";
import { ADMIN_API_PREFIXES, PUBLIC_ADMIN_API_PATHS, validAdminMutationOrigin, authorizedAdminRequest } from "@/lib/admin-request-policy";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";


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

  if (ADMIN_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    if (!validAdminMutationOrigin(req)) return NextResponse.json({error: "Invalid request origin"}, {status: 403});
    if (!PUBLIC_ADMIN_API_PATHS.has(pathname)) {
      const token = req.cookies.get(adminSessionTransport().cookie)?.value;
      if (!token) return NextResponse.json({error: "Unauthorized"}, {status: 401});
      try {
        const actor=await loadAdminActor(token);
        if(!actor)return NextResponse.json({error:"Unauthorized"},{status:401});
        if (!authorizedAdminRequest(actor.role, req.method, pathname)) return NextResponse.json({error: "Forbidden"}, {status: 403});
      } catch { return NextResponse.json({error: "Core backend unavailable"}, {status: 503}); }
    }
    return NextResponse.next();
  }
  // Allow public paths through without auth check
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const sessionCookie=req.cookies.get(adminSessionTransport().cookie);
  if(!sessionCookie?.value)return NextResponse.redirect(new URL("/login",req.url));
  try{if(!await loadAdminActor(sessionCookie.value))return NextResponse.redirect(new URL("/login",req.url));}
  catch{return NextResponse.redirect(new URL("/login",req.url));}

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
