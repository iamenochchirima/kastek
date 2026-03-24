import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  exchangeXCodeForTokens,
  fetchXMe,
  upsertXConnectionForUser,
} from "@/lib/social/x";
import { getSocialAppUrl } from "@/lib/social/env";

export const runtime = "nodejs";

const X_STATE_COOKIE = "kasitek_social_x_state";
const X_VERIFIER_COOKIE = "kasitek_social_x_verifier";

export async function GET(req: NextRequest) {
  const appUrl = getSocialAppUrl();
  const redirectBase = new URL("/social/channels", appUrl);

  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.redirect(new URL("/login", appUrl));
    }

    const searchParams = req.nextUrl.searchParams;
    const code = searchParams.get("code");
    const returnedState = searchParams.get("state");
    const oauthError = searchParams.get("error");

    if (oauthError) {
      return NextResponse.redirect(
        new URL(
          `/social/channels?error=${encodeURIComponent(oauthError)}`,
          appUrl,
        ),
      );
    }

    if (!code || !returnedState) {
      return NextResponse.redirect(
        new URL("/social/channels?error=Missing%20OAuth%20code", appUrl),
      );
    }

    const cookieStore = await cookies();
    const storedState = cookieStore.get(X_STATE_COOKIE)?.value;
    const verifier = cookieStore.get(X_VERIFIER_COOKIE)?.value;

    if (!storedState || !verifier || storedState !== returnedState) {
      return NextResponse.redirect(
        new URL("/social/channels?error=Invalid%20OAuth%20state", appUrl),
      );
    }

    const tokens = await exchangeXCodeForTokens({
      code,
      codeVerifier: verifier,
    });
    const profile = await fetchXMe(tokens.access_token as string);
    await upsertXConnectionForUser({
      userId,
      tokens,
      profile,
    });

    const response = NextResponse.redirect(
      new URL("/social/channels?connected=x", appUrl),
    );
    response.cookies.set(X_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    response.cookies.set(X_VERIFIER_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to connect X account";
    redirectBase.searchParams.set("error", message);
    return NextResponse.redirect(redirectBase);
  }
}
