const TELEGRAM_USER_ID = /^\d+$/;
const WHATSAPP_PHONE_DIGITS = /^\d{7,15}$/;

export function normalizeTelegramAllowedUsers(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => TELEGRAM_USER_ID.test(entry)))].slice(0, 100);
}

export function telegramAllowedUsers(metadata: Record<string, unknown>): string[] {
  const access = metadata.telegramAccess && typeof metadata.telegramAccess === "object"
    ? metadata.telegramAccess as Record<string, unknown>
    : {};
  return normalizeTelegramAllowedUsers(access.allowedUsers);
}

export function telegramUserAllowed(metadata: Record<string, unknown>, externalIdentity: string): boolean {
  const allowedUsers = telegramAllowedUsers(metadata);
  return allowedUsers.length === 0 || allowedUsers.includes(externalIdentity);
}

export function normalizeWhatsappPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\s().-]/g, "");
  const digits = compact.startsWith("+")
    ? compact.slice(1)
    : compact.startsWith("00")
      ? compact.slice(2)
      : compact;
  return WHATSAPP_PHONE_DIGITS.test(digits) ? digits : null;
}

export function normalizeWhatsappAllowedPhones(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values
    .map((entry) => normalizeWhatsappPhone(entry))
    .filter((entry): entry is string => Boolean(entry)))].slice(0, 100);
}

export function whatsappAllowedPhones(metadata: Record<string, unknown>): string[] {
  const access = metadata.whatsappAccess && typeof metadata.whatsappAccess === "object"
    ? metadata.whatsappAccess as Record<string, unknown>
    : {};
  return normalizeWhatsappAllowedPhones(access.allowedPhones);
}

export function whatsappPhoneAllowed(metadata: Record<string, unknown>, externalIdentity: string): boolean {
  const allowedPhones = whatsappAllowedPhones(metadata);
  const phone = normalizeWhatsappPhone(externalIdentity);
  return allowedPhones.length === 0 || (phone !== null && allowedPhones.includes(phone));
}
