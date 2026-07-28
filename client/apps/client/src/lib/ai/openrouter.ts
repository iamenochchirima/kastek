type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    error?: {
      message?: string;
    };
  }>;
};

function hasChoices(payload: unknown): payload is OpenRouterResponse {
  return typeof payload === "object" && payload !== null && "choices" in payload;
}

function getOpenRouterApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
  }

  return apiKey;
}

function getOpenRouterModel() {
  return process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini";
}

function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export async function generateSocialCaptionWithOpenRouter({
  messages,
  responseSchemaHint,
}: {
  messages: OpenRouterMessage[];
  responseSchemaHint?: string;
}) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOpenRouterApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": getAppUrl(),
      "X-OpenRouter-Title": "KasiTek Content",
    },
    body: JSON.stringify({
      model: getOpenRouterModel(),
      temperature: 0.7,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: responseSchemaHint
        ? [
            ...messages,
            {
              role: "assistant",
              content: responseSchemaHint,
            },
          ]
        : messages,
    }),
  });

  const payload = (await response.json().catch(() => null)) as OpenRouterResponse | {
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && payload !== null && "error" in payload
        ? payload.error?.message || "OpenRouter request failed"
        : "OpenRouter request failed";
    throw new Error(message);
  }

  const content = hasChoices(payload) ? payload.choices?.[0]?.message?.content?.trim() : undefined;
  if (!content) {
    throw new Error("OpenRouter returned an empty response");
  }

  return content;
}
