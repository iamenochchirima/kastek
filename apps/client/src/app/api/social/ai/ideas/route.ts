import { SocialPlatform } from "@kasitek/database";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateSocialCaptionWithOpenRouter } from "@/lib/ai/openrouter";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type IdeaRequest = {
  topic?: string;
  objective?: string;
  channels?: SocialPlatform[];
};

type IdeaResponse = {
  ideas?: Array<{
    title: string;
    angle: string;
    hook: string;
    draft: string;
    suggestedChannels?: SocialPlatform[];
  }>;
};

const platformValues = Object.values(SocialPlatform);

function getPlatformLabel(platform: SocialPlatform) {
  if (platform === "FACEBOOK") return "Facebook";
  if (platform === "INSTAGRAM") return "Instagram";
  if (platform === "LINKEDIN") return "LinkedIn";
  if (platform === "X") return "X";
  return "WhatsApp Status";
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as IdeaRequest;
    const topic = body.topic?.trim() || "";
    const objective = body.objective?.trim() || "";
    const channels = (body.channels || []).filter((channel) => platformValues.includes(channel));

    if (!topic && !objective) {
      return NextResponse.json(
        { error: "Add a topic or objective before generating ideas" },
        { status: 400 },
      );
    }

    const businessProfile = await prisma.businessProfile.findUnique({
      where: { userId },
      select: {
        businessName: true,
        businessType: true,
        industry: true,
        description: true,
        city: true,
        province: true,
        country: true,
        website: true,
      },
    });

    const raw = await generateSocialCaptionWithOpenRouter({
      messages: [
        {
          role: "system",
          content: [
            "You are the strategy brain for KasiSocial.",
            "Generate practical social media post ideas for a business owner who wants usable drafts right now.",
            "Return valid JSON only.",
            'JSON shape: {"ideas":[{"title":"string","angle":"string","hook":"string","draft":"string","suggestedChannels":["FACEBOOK"|"INSTAGRAM"|"LINKEDIN"|"X"|"WHATSAPP_STATUS"]}]}',
            "Generate exactly 4 ideas.",
            "Each draft should already feel postable, not like a note.",
            "LinkedIn-friendly ideas should be more thoughtful and authority-building.",
            "X-friendly ideas should be concise and sharp.",
            "Do not include markdown fences.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Business context: ${JSON.stringify({
              businessName: businessProfile?.businessName || null,
              businessType: businessProfile?.businessType || null,
              industry: businessProfile?.industry || null,
              description: businessProfile?.description || null,
              location: [businessProfile?.city, businessProfile?.province, businessProfile?.country]
                .filter(Boolean)
                .join(", ") || null,
              website: businessProfile?.website || null,
            })}`,
            `Topic: ${topic || "Not specified"}`,
            `Objective: ${objective || "General growth and audience engagement"}`,
            `Preferred channels: ${channels.map(getPlatformLabel).join(", ") || "Not specified"}`,
            "Return a mix of educational, promotional, and credibility-building ideas the user can turn into drafts immediately.",
          ].join("\n"),
        },
      ],
    });

    let parsed: IdeaResponse;

    try {
      parsed = JSON.parse(raw) as IdeaResponse;
    } catch {
      throw new Error("AI response was not valid JSON");
    }

    const ideas = (parsed.ideas || [])
      .map((idea) => ({
        title: idea.title?.trim() || "",
        angle: idea.angle?.trim() || "",
        hook: idea.hook?.trim() || "",
        draft: idea.draft?.trim() || "",
        suggestedChannels: (idea.suggestedChannels || []).filter((channel) =>
          platformValues.includes(channel),
        ),
      }))
      .filter((idea) => idea.title && idea.draft);

    if (ideas.length === 0) {
      throw new Error("AI response did not include usable ideas");
    }

    return NextResponse.json({ ideas });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate ideas";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
