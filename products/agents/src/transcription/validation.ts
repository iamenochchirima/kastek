export const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "application/ogg",
]);

export function normalizeAudioMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function isSupportedAudioMimeType(value: string): boolean {
  return SUPPORTED_AUDIO_MIME_TYPES.has(normalizeAudioMimeType(value));
}

export function hasAudioFileSignature(mimeType: string, bytes: Uint8Array): boolean {
  const mime = normalizeAudioMimeType(mimeType);
  const startsWith = (prefix: Uint8Array): boolean => bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
  switch (mime) {
    case "audio/aac":
      return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
    case "audio/flac":
      return startsWith(new TextEncoder().encode("fLaC"));
    case "audio/m4a":
    case "audio/mp4":
      return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
    case "audio/mpeg":
      return startsWith(new TextEncoder().encode("ID3")) || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    case "audio/ogg":
    case "audio/opus":
    case "application/ogg":
      return startsWith(new TextEncoder().encode("OggS"));
    case "audio/wav":
      return bytes.length >= 12 && startsWith(new TextEncoder().encode("RIFF")) && String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";
    case "audio/webm":
      return startsWith(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    default:
      return false;
  }
}
