import { describe, expect, it } from "vitest";
import { websiteWidgetScript } from "../src/adapters/channels/website/widget";

describe("website widget presentation", () => {
  it("uses the same outline launcher icon as the editor preview", () => {
    const script = websiteWidgetScript("fixture");
    expect(script).toContain('launcher:\'<path d="M2.992 16.342');
    expect(script).toContain("icon(toggle,'launcher')");
  });

  it("renders a flat accent launcher without a border or halo", () => {
    const script = websiteWidgetScript("fixture");
    expect(script).toContain(".launcher{display:grid;place-items:center;width:var(--launcher-size,56px);height:var(--launcher-size,56px);border-radius:50%");
    expect(script).not.toContain("0 0 0 5px color-mix");
    expect(script).not.toContain("border:1px solid #ffffffb8");
  });
});
