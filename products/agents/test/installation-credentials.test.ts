import { describe, expect, it } from "vitest";
import { installationCredentialHashing } from "../src/db/repositories/installation-credential-repository";

describe("installation credential hashing", () => {
  it("verifies only the exact copy-once secret", () => {
    const hash = installationCredentialHashing.hashSecret("ksi_example-secret");
    expect(hash).not.toContain("ksi_example-secret");
    expect(installationCredentialHashing.verifySecret("ksi_example-secret", hash)).toBe(true);
    expect(installationCredentialHashing.verifySecret("ksi_wrong-secret", hash)).toBe(false);
  });
});
