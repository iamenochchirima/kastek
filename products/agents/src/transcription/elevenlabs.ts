import type { AppConfig } from "../config";
import {
  AudioTranscriptionError,
  type AudioTranscriptionInput,
  type AudioTranscriptionProvider,
  type AudioTranscriptionResult,
} from "./provider";

interface ElevenLabsSpeechToTextResponse {
  text?: unknown;
  language_code?: unknown;
}

export interface ElevenLabsTranscriptionProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ElevenLabsTranscriptionProvider implements AudioTranscriptionProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: ElevenLabsTranscriptionProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
    this.modelId = options.modelId?.trim() || "scribe_v2";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public static fromConfig(config: AppConfig): ElevenLabsTranscriptionProvider {
    return new ElevenLabsTranscriptionProvider({
      apiKey: config.ELEVENLABS_API_KEY,
      baseUrl: config.ELEVENLABS_API_BASE_URL,
      modelId: config.ELEVENLABS_TRANSCRIPTION_MODEL,
      timeoutMs: config.ELEVENLABS_TRANSCRIPTION_TIMEOUT_MS,
    });
  }

  public async transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    if (!this.apiKey) {
      throw new AudioTranscriptionError("Audio transcription is not configured", "AUDIO_TRANSCRIPTION_NOT_CONFIGURED", false, 503);
    }

    const form = new FormData();
    form.append("model_id", this.modelId);
    if (input.languageHint?.trim()) form.append("language_code", input.languageHint.trim());
    form.append("file", new Blob([Buffer.from(input.bytes)], { type: input.mimeType }), input.fileName?.trim() || "audio");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new AudioTranscriptionError("Audio transcription provider is rate limited", "AUDIO_TRANSCRIPTION_RATE_LIMITED", true, 503);
        }
        if (response.status >= 500) {
          throw new AudioTranscriptionError("Audio transcription provider is unavailable", "AUDIO_TRANSCRIPTION_PROVIDER_FAILED", true, 503);
        }
        if (response.status === 401 || response.status === 403) {
          throw new AudioTranscriptionError("Audio transcription provider credentials were rejected", "AUDIO_TRANSCRIPTION_PROVIDER_AUTH_FAILED", false, 503);
        }
        throw new AudioTranscriptionError("Audio could not be transcribed", "AUDIO_TRANSCRIPTION_INVALID_MEDIA", false, 422);
      }
      let payload: ElevenLabsSpeechToTextResponse;
      try {
        payload = await response.json() as ElevenLabsSpeechToTextResponse;
      } catch {
        throw new AudioTranscriptionError("Audio transcription provider returned invalid data", "AUDIO_TRANSCRIPTION_MALFORMED_RESPONSE", true, 502);
      }
      if (typeof payload.text !== "string") {
        throw new AudioTranscriptionError("Audio transcription provider returned invalid data", "AUDIO_TRANSCRIPTION_MALFORMED_RESPONSE", true, 502);
      }
      const text = payload.text.trim();
      if (!text) throw new AudioTranscriptionError("No speech was detected", "AUDIO_TRANSCRIPTION_EMPTY", false, 422);
      return {
        text: text.slice(0, 200_000),
        ...(typeof payload.language_code === "string" && payload.language_code.trim() ? { languageCode: payload.language_code.trim().slice(0, 32) } : {}),
      };
    } catch (error) {
      if (error instanceof AudioTranscriptionError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AudioTranscriptionError("Audio transcription provider timed out", "AUDIO_TRANSCRIPTION_PROVIDER_FAILED", true, 503);
      }
      throw new AudioTranscriptionError("Audio transcription provider request failed", "AUDIO_TRANSCRIPTION_PROVIDER_FAILED", true, 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}
