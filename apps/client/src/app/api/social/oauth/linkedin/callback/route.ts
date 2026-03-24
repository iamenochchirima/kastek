import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  exchangeLinkedInCodeForTokens,
  fetchLinkedInProfile,
  upsertLinkedInConnectionForUser,
} from "@/lib/social/linkedin";
import { getSocialAppUrl } from "@/lib/social/env";

export const runtime = "nodejs";

const LINKEDIN_STATE_COOKIE = "kasitek_social_linkedin_state";

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
    const oauthErrorDescription = searchParams.get("error_description");

    if (oauthError) {
      const message = oauthErrorDescription || oauthError;
      return NextResponse.redirect(
        new URL(`/social/channels?error=${encodeURIComponent(message)}`, appUrl),
      );
    }

    if (!code || !returnedState) {
      return NextResponse.redirect(
        new URL("/social/channels?error=Missing%20OAuth%20code", appUrl),
      );
    }

    const cookieStore = await cookies();
    const storedState = cookieStore.get(LINKEDIN_STATE_COOKIE)?.value;

    if (!storedState || storedState !== returnedState) {
      return NextResponse.redirect(
        new URL("/social/channels?error=Invalid%20OAuth%20state", appUrl),
      );
    }

    const tokens = await exchangeLinkedInCodeForTokens(code);
    const profile = await fetchLinkedInProfile(tokens.access_token as string);
    await upsertLinkedInConnectionForUser({
      userId,
      tokens,
      profile: {
        ...profile,
        sub: profile.sub as string,
      },
    });

    const response = NextResponse.redirect(
      new URL("/social/channels?connected=linkedin", appUrl),
    );
    response.cookies.set(LINKEDIN_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to connect LinkedIn account";
    redirectBase.searchParams.set("error", message);
    return NextResponse.redirect(redirectBase);
  }
}
