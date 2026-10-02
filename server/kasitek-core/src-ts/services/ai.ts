import type { Pool } from "pg";
import { canonicalJson } from "@kasitek/server-support/json";
import { bad, internal, PLATFORMS } from "./social/common.js";
export interface SocialIdeasRequest {
  topic?: string | null;
  objective?: string | null;
  channels?: string[] | null;
}
export interface SocialCaptionRequest {
  prompt?: string | null;
  title?: string | null;
  channels?: string[] | null;
  currentContent?: string | null;
}
export interface AiOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}
const LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  THREADS: "Threads",
  TIKTOK: "TikTok",
  BLUESKY: "Bluesky",
  LINKEDIN: "LinkedIn",
  X: "X",
};
const channelsFor = (channels: string[] | null | undefined) =>
  (channels ?? [])
    .map((value) => value.trim().toUpperCase())
    .filter((value) => PLATFORMS.includes(value));
const selected = (value: unknown, fallback: string[] = []) =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && PLATFORMS.includes(item),
      )
    : fallback;
async function businessContext(pool: Pool, userId: string) {
  const row = (
    await pool.query(
      'SELECT "businessName", "businessType", industry, description, city, province, country, website FROM "BusinessProfile" WHERE "userId"=$1 LIMIT 1',
      [userId],
    )
  ).rows[0];
  return {
    businessName: row?.businessName ?? null,
    businessType: row?.businessType ?? null,
    industry: row?.industry ?? null,
    description: row?.description ?? null,
    location: row
      ? [row.city, row.province, row.country]
          .filter((value) => value != null)
          .join(", ")
      : null,
    website: row?.website ?? null,
  };
}
async function generate(messages: unknown[], options: AiOptions) {
  const env = options.env ?? process.env;
  if (env.OPENROUTER_API_KEY === undefined)
    throw internal("OPENROUTER_API_KEY is required");
  const response = await (options.fetch ?? fetch)(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.FRONTEND_URL ?? "http://localhost:3000",
        "X-OpenRouter-Title": "KasiTek Content",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL ?? "openai/gpt-4.1-mini",
        temperature: 0.7,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages,
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
    choices?: { message?: { content?: unknown } }[];
  } | null;
  if (!response.ok)
    throw internal(
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : "OpenRouter request failed",
    );
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw internal("OpenRouter returned an empty response");
  try {
    return JSON.parse(text.trim()) as Record<string, unknown>;
  } catch {
    throw internal("AI response was not valid JSON");
  }
}
const IDEAS_PROMPT =
  'You are the strategy assistant for the KasiTek content workspace. Generate practical social media post ideas for a business owner who wants usable drafts right now. Return valid JSON only. JSON shape: {"ideas":[{"title":"string","angle":"string","hook":"string","draft":"string","suggestedChannels":["FACEBOOK"|"INSTAGRAM"|"THREADS"|"TIKTOK"|"BLUESKY"|"LINKEDIN"|"X"]}]} Generate exactly 4 ideas. Each draft should already feel postable, not like a note. LinkedIn-friendly ideas should be more thoughtful and authority-building. X-friendly ideas should be concise and sharp. Do not include markdown fences.';
const CAPTION_PROMPT =
  'You write social media copy for businesses using the KasiTek content workspace. Return valid JSON only. JSON shape: {"title":"string","content":"string","suggestedChannels":["FACEBOOK"|"INSTAGRAM"|"THREADS"|"TIKTOK"|"BLUESKY"|"LINKEDIN"|"X"],"variants":[{"platform":"FACEBOOK"|"INSTAGRAM"|"THREADS"|"TIKTOK"|"BLUESKY"|"LINKEDIN"|"X","content":"string"}]}. Keep copy aligned with the business voice and practical for real posting. Do not include markdown fences. Prefer concise, publish-ready output. If channels are provided, tailor the output for those channels but keep one unified caption. Make LinkedIn variants more developed and professional than the others. Make X variants compact and punchy.';

export async function generateSocialIdeas(
  pool: Pool,
  userId: string,
  input: SocialIdeasRequest,
  options: AiOptions = {},
) {
  const topic = input.topic?.trim() ?? "";
  const objective = input.objective?.trim() ?? "";
  const channels = channelsFor(input.channels);
  if (!topic && !objective)
    throw bad("Add a topic or objective before generating ideas");
  const context = await businessContext(pool, userId);
  const content = `Business context: ${canonicalJson(context)}\nTopic: ${topic || "Not specified"}\nObjective: ${objective || "General growth and audience engagement"}\nPreferred channels: ${channels.length ? channels.map((channel) => LABELS[channel]).join(", ") : "Not specified"}\nReturn a mix of educational, promotional, and credibility-building ideas the user can turn into drafts immediately.`;
  const parsed = await generate(
    [
      { role: "system", content: IDEAS_PROMPT },
      { role: "user", content },
    ],
    options,
  );
  const ideas = (Array.isArray(parsed.ideas) ? parsed.ideas : []).flatMap(
    (idea: Record<string, unknown>) => {
      if (
        typeof idea?.title !== "string" ||
        typeof idea.draft !== "string" ||
        !idea.title.trim() ||
        !idea.draft.trim()
      )
        return [];
      return [
        {
          title: idea.title.trim(),
          angle: typeof idea.angle === "string" ? idea.angle.trim() : "",
          hook: typeof idea.hook === "string" ? idea.hook.trim() : "",
          draft: idea.draft.trim(),
          suggestedChannels: selected(idea.suggestedChannels),
        },
      ];
    },
  );
  if (!ideas.length) throw internal("AI response did not include usable ideas");
  return { ideas };
}
export async function generateSocialCaption(
  pool: Pool,
  userId: string,
  input: SocialCaptionRequest,
  options: AiOptions = {},
) {
  const prompt = input.prompt?.trim() ?? "";
  const title = input.title?.trim() ?? "";
  const current = input.currentContent?.trim() ?? "";
  const channels = channelsFor(input.channels);
  if (!prompt && !title && !current)
    throw bad("Provide a prompt, title, or current content to generate from");
  const context = await businessContext(pool, userId);
  const content = `Business context: ${canonicalJson(context)}\nRequested channels: ${channels.length ? channels.map((channel) => LABELS[channel]).join(", ") : "Not specified"}\nCurrent title: ${title || "None"}\nPrompt: ${prompt || "None"}\nCurrent content: ${current || "None"}\nGenerate a strong master title and caption, then generate one variant per selected platform. If the prompt is vague, make a sensible business-ready assumption.`;
  const parsed = await generate(
    [
      { role: "system", content: CAPTION_PROMPT },
      { role: "user", content },
    ],
    options,
  );
  if (typeof parsed.content !== "string" || !parsed.content.trim())
    throw internal("AI response did not include caption content");
  const variants = (
    Array.isArray(parsed.variants) ? parsed.variants : []
  ).flatMap((variant: Record<string, unknown>) =>
    typeof variant?.platform === "string" &&
    PLATFORMS.includes(variant.platform) &&
    typeof variant.content === "string" &&
    variant.content.trim()
      ? [{ platform: variant.platform, content: variant.content.trim() }]
      : [],
  );
  return {
    draft: {
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim()
          : title || "Untitled social post",
      content: parsed.content.trim(),
      suggestedChannels: selected(parsed.suggestedChannels, channels),
      variants,
    },
  };
}
