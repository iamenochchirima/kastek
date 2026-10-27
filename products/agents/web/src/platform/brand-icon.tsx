import { useState, type ReactNode } from "react";

const marks: Record<string, string> = {
  whatsapp: "whatsapp.svg",
  telegram: "telegram.svg",
  instagram: "instagram.svg",
  facebook: "messenger.svg",
  hubspot: "hubspot.svg",
  github: "github.svg",
  "google-calendar": "google-calendar.svg",
  gmail: "google-gmail.svg",
  "google-drive": "google-drive.svg",
};

/** Brand marks are decorative; the adjacent text names the service. */
export function BrandIcon({ name, fallback }: { name: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const file = marks[name];
  return file && !failed ? <img className={name === "github" ? "brand-github" : undefined} src={`/images/integrations/${file}`} alt="" onError={() => setFailed(true)} /> : fallback;
}
