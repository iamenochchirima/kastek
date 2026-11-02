export const productUrls = {
  agents: "https://agents.kasitek.co.za",
  growth: "https://app.kasitek.co.za",
  agency: "https://portal.kasitek.co.za",
} as const;

export const appUrl = productUrls.growth;

export function websiteWidgetConfiguration(env: Record<string, string | undefined>) {
  const base = env.NEXT_PUBLIC_AGENTS_PUBLIC_URL?.trim(), deployment = env.NEXT_PUBLIC_AGENTS_WIDGET_DEPLOYMENT_ID?.trim();
  if (!base || !deployment || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(deployment)) return null;
  try {
    const url = new URL(base);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local && url.protocol === "http:"))) return null;
    return { src: url.origin + "/api/website/" + deployment + "/widget.js" };
  } catch { return null; }
}

export const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";
