import { describe, expect, it, vi } from "vitest";
import { ElevenLabsTranscriptionProvider } from "../src/transcription/elevenlabs";
import { AudioTranscriptionError } from "../src/transcription/provider";
import { hasAudioFileSignature, isSupportedAudioMimeType, MAX_AUDIO_FILE_BYTES } from "../src/transcription/validation";

describe("audio transcription validation", () => {
  it("accepts supported audio signatures and rejects mismatched content", () => {
    expect(isSupportedAudioMimeType("audio/ogg; codecs=opus")).toBe(true);
    expect(hasAudioFileSignature("audio/ogg", new TextEncoder().encode("OggS-opus"))).toBe(true);
    expect(hasAudioFileSignature("audio/wav", new TextEncoder().encode("OggS-opus"))).toBe(false);
    expect(MAX_AUDIO_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("ElevenLabsTranscriptionProvider", () => {
  it("normalizes a successful Scribe response without logging or retaining the payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: "  Hello from audio.  ", language_code: "eng" }), { status: 200 });
    });
    const provider = new ElevenLabsTranscriptionProvider({ apiKey: "test-key", fetchImpl });

    await expect(provider.transcribe({
      bytes: new TextEncoder().encode("audio"),
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
    })).resolves.toEqual({ text: "Hello from audio.", languageCode: "eng" });
  });

  it("maps rate limits to a retryable stable error", async () => {
    const provider = new ElevenLabsTranscriptionProvider({
      apiKey: "test-key",
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("", { status: 429 })),
    });

    await expect(provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" })).rejects.toMatchObject({
      code: "AUDIO_TRANSCRIPTION_RATE_LIMITED",
      retryable: true,
      statusCode: 503,
    } satisfies Partial<AudioTranscriptionError>);
  });

  it("reports missing configuration without making a provider request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new ElevenLabsTranscriptionProvider({ fetchImpl });

    await expect(provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" })).rejects.toMatchObject({
      code: "AUDIO_TRANSCRIPTION_NOT_CONFIGURED",
      statusCode: 503,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
