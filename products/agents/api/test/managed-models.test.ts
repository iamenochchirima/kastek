import { describe, expect, it } from "vitest";
import { managedModelIds } from "../src/contracts/model-providers";

describe("managed model allowlist", () => {
  it("returns null for customer-supplied connections", () => {
    expect(managedModelIds({ managed_model_id: null })).toBeNull();
    expect(managedModelIds({})).toBeNull();
  });

  it("exposes the full provider catalogue when the managed allowlist is empty", () => {
    expect(managedModelIds({ managed_model_id: "openai/gpt-5.6-luna" })).toBeNull();
    expect(managedModelIds({ managed_model_id: "openai/gpt-5.6-luna", managed_model_ids: [] })).toBeNull();
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
