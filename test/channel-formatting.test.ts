import { describe, expect, it } from "vitest";
import { formatTelegramText, formatWhatsAppText } from "../src/channels/formatting";

const sample = `I can help you with:

- **Connections:** View connected accounts.
- **Content:** List and read posts, drafts, and schedules.

Use \`/start\` to begin.`;

describe("channel message formatting", () => {
  it("renders Markdown as Telegram HTML and normalizes list markers", () => {
    expect(formatTelegramText(sample)).toBe(`I can help you with:\n\n• <b>Connections:</b> View connected accounts.\n• <b>Content:</b> List and read posts, drafts, and schedules.\n\nUse <code>/start</code> to begin.`);
  });

  it("renders Markdown using WhatsApp-supported formatting", () => {
    expect(formatWhatsAppText(sample)).toBe([
      "I can help you with:",
      "",
      "• *Connections:* View connected accounts.",
      "• *Content:* List and read posts, drafts, and schedules.",
      "",
      "Use ```/start``` to begin.",
    ].join("\n"));
  });

  it("keeps tables, links, images, quotes, and code readable", () => {
    const rich = [
      "# Status",
      "",
      "| Account | State |",
      "| --- | --- |",
      "| **KasiAI** | Ready |",
      "",
      "> See [the dashboard](https://example.com).",
      "![Preview](https://example.com/image.png)",
      "Marked ==text== and ||spoiler||.",
      "",
      "```",
      "npm run test",
      "```",
    ].join("\n");

    expect(formatTelegramText(rich)).toContain("<b>Status</b>");
    expect(formatTelegramText(rich)).toContain("<a href=\"https://example.com\">the dashboard</a>");
    expect(formatTelegramText(rich)).toContain("<u>text</u>");
    expect(formatTelegramText(rich)).toContain("<tg-spoiler>spoiler</tg-spoiler>");
    expect(formatWhatsAppText(rich)).toContain("*Account:* *KasiAI*");
    expect(formatWhatsAppText(rich)).toContain("🖼️ Preview: https://example.com/image.png");
    expect(formatWhatsAppText(rich)).toContain("```\nnpm run test\n```");
  });

  it("escapes Telegram markup supplied as plain text", () => {
    expect(formatTelegramText("Use <status> & keep it plain.")).toBe("Use &lt;status&gt; &amp; keep it plain.");
  });
});
