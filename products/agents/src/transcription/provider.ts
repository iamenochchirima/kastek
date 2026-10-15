export interface AudioTranscriptionInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
  languageHint?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  languageCode?: string;
}

export type AudioTranscriptionErrorCode =
  | "AUDIO_TRANSCRIPTION_NOT_CONFIGURED"
  | "AUDIO_TRANSCRIPTION_INVALID_MEDIA"
  | "AUDIO_TRANSCRIPTION_RATE_LIMITED"
  | "AUDIO_TRANSCRIPTION_PROVIDER_FAILED"
  | "AUDIO_TRANSCRIPTION_PROVIDER_AUTH_FAILED"
  | "AUDIO_TRANSCRIPTION_MALFORMED_RESPONSE"
  | "AUDIO_TRANSCRIPTION_EMPTY";

export class AudioTranscriptionError extends Error {
  public constructor(
    message: string,
    public readonly code: AudioTranscriptionErrorCode,
    public readonly retryable: boolean,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = "AudioTranscriptionError";
  }
}

export interface AudioTranscriptionProvider {
  transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
}
