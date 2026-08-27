export const appUrl = "https://app.kasitek.co.za";

const publicApiOrigin =
  process.env.NEXT_PUBLIC_KASITEK_PUBLIC_API_URL ?? "https://dev-client.kasitek.co.za";

export const widgetLoaderUrl = `${publicApiOrigin.replace(/\/$/, "")}/api/widget/v1/loader.js`;

export const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";
