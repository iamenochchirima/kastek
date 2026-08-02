export const appUrl =
  process.env.NEXT_PUBLIC_KASITEK_APP_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://app.kasitek.co.za"
    : "http://localhost:3000");

export const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";
