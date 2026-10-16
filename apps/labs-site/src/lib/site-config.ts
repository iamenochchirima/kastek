export const productUrls = {
  agents: "https://agents.kasitek.co.za",
  growth: "https://growth.kasitek.co.za",
  agency: "https://agencies.kasitek.co.za",
} as const;

export const appUrl = productUrls.growth;

const publicApiOrigin =
  process.env.NEXT_PUBLIC_KASITEK_PUBLIC_API_URL ?? "https://api.kasitek.co.za";

export const widgetLoaderUrl = `${publicApiOrigin.replace(/\/$/, "")}/api/widget/v1/loader.js`;

export const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";
