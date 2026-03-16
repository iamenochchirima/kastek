import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildXAuthorizeUrl,
  createXOAuthState,
  getSocialAppUrl,
} from "@/lib/social/x";

export const runtime = "nodejs";

const X_STATE_COOKIE = "kasitek_social_x_state";
const X_VERIFIER_COOKIE = "kasitek_social_x_verifier";

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.redirect(new URL("/login", getSocialAppUrl()));
    }

    const { state, verifier, challenge } = createXOAuthState();
    const authorizeUrl = buildXAuthorizeUrl({ state, challenge });
    const response = NextResponse.redirect(authorizeUrl);
    const secure = process.env.NODE_ENV === "production";

    response.cookies.set(X_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 60 * 10,
    });
    response.cookies.set(X_VERIFIER_COOKIE, verifier, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 60 * 10,
    });

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start X OAuth";

      return NextResponse.redirect(
        new URL(
          `/social/channels?error=${encodeURIComponent(message)}`,
          getSocialAppUrl(),
        ),
      );
  }
}
