/** Known encodings of a credential; this is not a general secret detector. */
export function credentialReflectionVariants(value: string): string[] {
  if (!value) return [];
  if (value.length < 12) return [value];
  return [...new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")])];
}

/** Detect known reflections of the active connector credential before storing a response. */
export function containsConnectorCredential(body: Buffer, authorization: string): boolean {
  if (!authorization) return false;
  if (body.includes(Buffer.from(authorization))) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  const values = [authorization, ...(bearer && bearer.length >= 12 ? [bearer] : [])];
  return values.some(value => credentialReflectionVariants(value).some(candidate => body.includes(Buffer.from(candidate))));
}
