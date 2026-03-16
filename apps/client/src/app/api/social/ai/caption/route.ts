import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateSocialCaptionWithOpenRouter } from "@/lib/ai/openrouter";
import { SocialPlatform } from "@kasitek/database";

export const runtime = "nodejs";

type CaptionRequest = {
  prompt?: string;
  title?: string | null;
  channels?: SocialPlatform[];
  currentContent?: string | null;
};

type CaptionResponse = {
  title: string;
  content: string;
  suggestedChannels?: SocialPlatform[];
  variants?: Array<{
    platform: SocialPlatform;
    content: string;
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

    const body = (await req.json().catch(() => ({}))) as CaptionRequest;
    const prompt = body.prompt?.trim() || "";
    const title = body.title?.trim() || "";
    const currentContent = body.currentContent?.trim() || "";
    const channels = (body.channels || []).filter((channel) => platformValues.includes(channel));

    if (!prompt && !title && !currentContent) {
      return NextResponse.json(
        { error: "Provide a prompt, title, or current content to generate from" },
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

    const systemPrompt = [
      "You write high-performing social media copy for businesses using KasiSocial.",
      "Return valid JSON only.",
      'JSON shape: {"title":"string","content":"string","suggestedChannels":["FACEBOOK"|"INSTAGRAM"|"LINKEDIN"|"X"|"WHATSAPP_STATUS"],"variants":[{"platform":"FACEBOOK"|"INSTAGRAM"|"LINKEDIN"|"X"|"WHATSAPP_STATUS","content":"string"}]}.',
      "Keep copy aligned with the business voice and practical for real posting.",
      "Do not include markdown fences.",
      "Prefer concise, publish-ready output.",
      "If channels are provided, tailor the output for those channels but keep one unified caption.",
      "Make LinkedIn variants more developed and professional than the others.",
      "Make X variants compact and punchy.",
      "Make WhatsApp Status variants extremely short.",
    ].join(" ");

    const userPrompt = [
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
      `Requested channels: ${channels.map(getPlatformLabel).join(", ") || "Not specified"}`,
      `Current title: ${title || "None"}`,
      `Prompt: ${prompt || "None"}`,
      `Current content: ${currentContent || "None"}`,
      "Generate a strong master title and caption, then generate one variant per selected platform. If the prompt is vague, make a sensible business-ready assumption.",
    ].join("\n");

    const raw = await generateSocialCaptionWithOpenRouter({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let parsed: CaptionResponse;

    try {
      parsed = JSON.parse(raw) as CaptionResponse;
    } catch {
      throw new Error("AI response was not valid JSON");
    }

    const safeChannels = (parsed.suggestedChannels || []).filter((channel) =>
      platformValues.includes(channel),
    );
    const safeVariants = (parsed.variants || [])
      .filter((variant) => platformValues.includes(variant.platform) && variant.content?.trim())
      .map((variant) => ({
        platform: variant.platform,
        content: variant.content.trim(),
      }));

    if (!parsed.content?.trim()) {
      throw new Error("AI response did not include caption content");
    }

    return NextResponse.json({
      draft: {
        title: parsed.title?.trim() || title || "Untitled social post",
        content: parsed.content.trim(),
        suggestedChannels: safeChannels.length ? safeChannels : channels,
        variants: safeVariants,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate caption";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
