import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { completeEmbeddedSignup } from "@/lib/whatsapp/onboarding-service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      code?: string;
      wabaId?: string;
      phoneNumberId?: string;
    };

    if (!body.code) {
      return NextResponse.json({ error: "Missing embedded signup code" }, { status: 400 });
    }

    const result = await completeEmbeddedSignup({
      userId,
      code: body.code,
      wabaId: body.wabaId,
      phoneNumberId: body.phoneNumberId,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onboarding failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
