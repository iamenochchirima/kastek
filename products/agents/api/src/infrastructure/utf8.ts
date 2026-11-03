export function fitUtf8(text: string, maxBytes: number): string {
  let result = "", remaining = maxBytes;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (size > remaining) break;
    result += character; remaining -= size;
  }
  return result;
}
