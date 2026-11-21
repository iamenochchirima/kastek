import { credentialReflectionVariants } from "../../infrastructure/credential-reflection";

/** Check the credential already held by the dispatcher, without exposing it to a separate service. */
export function payloadContainsModelCredential(payload: unknown, credential: string): boolean {
  if (!credential) return false;
  const variants = credentialReflectionVariants(credential);
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") return variants.some(variant => credential.length < 12 ? value === variant : value.includes(variant));
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === "object") return Object.entries(value).some(([key, item]) =>
      variants.some(variant => credential.length < 12 ? key === variant : key.includes(variant)) || visit(item));
    return false;
  };
  return visit(payload);
}

/** Scan the joined stream as well as the completed receipt before either is released. */
export function responseContainsModelCredential(response: unknown, chunks: string[], credential: string): boolean {
  return payloadContainsModelCredential(response, credential) || payloadContainsModelCredential(chunks.join(""), credential);
}
