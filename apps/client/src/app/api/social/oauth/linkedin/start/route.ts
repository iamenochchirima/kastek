import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildLinkedInAuthorizeUrl, createLinkedInOAuthState } from "@/lib/social/linkedin";
import { getSocialAppUrl } from "@/lib/social/env";

export const runtime = "nodejs";

const LINKEDIN_STATE_COOKIE = "kasitek_social_linkedin_state";

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.redirect(new URL("/login", getSocialAppUrl()));
    }

    const state = createLinkedInOAuthState();
    const authorizeUrl = buildLinkedInAuthorizeUrl(state);
    const response = NextResponse.redirect(authorizeUrl);
    const secure = process.env.NODE_ENV === "production";

    response.cookies.set(LINKEDIN_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 60 * 10,
    });

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start LinkedIn OAuth";

    return NextResponse.redirect(
      new URL(`/social/channels?error=${encodeURIComponent(message)}`, getSocialAppUrl()),
    );
  }
}
