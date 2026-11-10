import { describe, expect, it } from "vitest";
import { managedModelIds } from "../src/contracts/model-providers";

describe("managed model allowlist", () => {
  it("returns null for customer-supplied connections", () => {
    expect(managedModelIds({ managed_model_id: null })).toBeNull();
    expect(managedModelIds({})).toBeNull();
  });

  it("falls back to the single pin for rows created before the allowlist", () => {
    expect(managedModelIds({ managed_model_id: "openai/gpt-5.6-luna" })).toEqual([
      "openai/gpt-5.6-luna",
    ]);
  });

  it("returns the stored allowlist", () => {
    expect(
      managedModelIds({
        managed_model_id: "openai/gpt-5.6-luna",
        managed_model_ids: ["openai/gpt-5.6-luna", "google/gemini-2.5-flash"],
      }),
    ).toEqual(["openai/gpt-5.6-luna", "google/gemini-2.5-flash"]);
  });
});
