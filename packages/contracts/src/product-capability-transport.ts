/** Installed signed-HTTP transport identity. Product operations remain destination-owned. */
export function createProductHttpAdapterManifest(product: string, release: string, digest: (value: unknown) => string) {
  return {
    schemaVersion: 1 as const, id: `${product}-product`, release,
    executableDigest: digest({ transport: "signed-product-http-v1", product, release }),
    transports: ["native_http" as const], protocolVersions: [], boundedSchemaValidation: true as const,
  };
}
