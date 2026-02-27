const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const DEFAULT_COUNTRY_CODE = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "+27";

function sanitize(raw: string): string {
  return raw.replace(/[\s()\-]/g, "");
}

export function normalizeToE164(rawPhone: string): string | null {
  if (!rawPhone) return null;

  const cleaned = sanitize(rawPhone);

  if (cleaned.startsWith("+")) {
    return E164_REGEX.test(cleaned) ? cleaned : null;
  }

  if (cleaned.startsWith("00")) {
    const withPlus = `+${cleaned.slice(2)}`;
    return E164_REGEX.test(withPlus) ? withPlus : null;
  }

  const digitsOnly = cleaned.replace(/\D/g, "");
  if (!digitsOnly) return null;

  if (digitsOnly.startsWith("0")) {
    const local = `${DEFAULT_COUNTRY_CODE}${digitsOnly.slice(1)}`;
    return E164_REGEX.test(local) ? local : null;
  }

  const international = `+${digitsOnly}`;
  return E164_REGEX.test(international) ? international : null;
}

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}
