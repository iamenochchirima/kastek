import { describe, expect, it } from "vitest";
import {
  normalizeTelegramAllowedUsers,
  normalizeWhatsappPhone,
  normalizeWhatsappAllowedPhones,
  telegramAllowedUsers,
  telegramUserAllowed,
  whatsappAllowedPhones,
  whatsappPhoneAllowed,
} from "../src/channels/access";

describe("Telegram personal-agent access", () => {
  it("normalizes comma-separated numeric user IDs and removes duplicates", () => {
    expect(normalizeTelegramAllowedUsers([" 123 ", "bad", "123", "456"])).toEqual(["123", "456"]);
    expect(normalizeTelegramAllowedUsers("123, 456, nope")).toEqual(["123", "456"]);
  });

  it("treats an empty allowlist as the pairing fallback and enforces configured IDs", () => {
    expect(telegramUserAllowed({}, "not-numeric")).toBe(true);
    const metadata = { telegramAccess: { allowedUsers: ["123456789"] } };
    expect(telegramAllowedUsers(metadata)).toEqual(["123456789"]);
    expect(telegramUserAllowed(metadata, "123456789")).toBe(true);
    expect(telegramUserAllowed(metadata, "987654321")).toBe(false);
  });
});

describe("WhatsApp personal-agent access", () => {
  it("normalizes the inbound identity to the same digits-only format as Meta/Waku", () => {
    expect(normalizeWhatsappPhone("+263 774 266 830")).toBe("263774266830");
    expect(normalizeWhatsappPhone("00263774266830")).toBe("263774266830");
  });

  it("normalizes international phone values and removes duplicates", () => {
    expect(normalizeWhatsappAllowedPhones(["+27 82 123-4567", "0027821234567", "27821234567", "bad"])).toEqual(["27821234567"]);
  });

  it("treats an empty allowlist as the pairing fallback and enforces configured phones", () => {
    expect(whatsappPhoneAllowed({}, "+27821234567")).toBe(true);
    const metadata = { whatsappAccess: { allowedPhones: ["27821234567"] } };
    expect(whatsappAllowedPhones(metadata)).toEqual(["27821234567"]);
    expect(whatsappPhoneAllowed(metadata, "+27821234567")).toBe(true);
    expect(whatsappPhoneAllowed(metadata, "+27829876543")).toBe(false);
  });
});
