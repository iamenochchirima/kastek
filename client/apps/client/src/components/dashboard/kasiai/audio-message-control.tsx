"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LoaderCircle, Mic, Paperclip, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type AudioMessageControlProps = {
  disabled?: boolean;
  onAudioReady: (file: File) => void;
  onError: (message: string) => void;
};

function recordingMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"]
    .find((value) => MediaRecorder.isTypeSupported(value)) ?? "";
}

export function AudioMessageControl({
  disabled = false,
  onAudioReady,
  onError,
}: AudioMessageControlProps) {
  const [recording, setRecording] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setPreparing(false);
  };

  const startRecording = async () => {
    if (disabled || recording || preparing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Audio recording is not supported in this browser");
      return;
    }
    setPreparing(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = recordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        onError("Audio recording failed");
        stopTracks();
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        stopTracks();
        if (!blob.size) {
          onError("No audio was recorded");
          return;
        }
        const extension = type.includes("ogg") ? "ogg" : "webm";
        onAudioReady(new File([blob], `kasiai-recording.${extension}`, { type }));
      };
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start();
      setPreparing(false);
      setRecording(true);
    } catch (error) {
      stopTracks();
      const name = error instanceof DOMException ? error.name : "";
      onError(
        name === "NotAllowedError"
          ? "Microphone permission is required"
          : "Unable to access the microphone",
      );
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const selectFile = () => {
    if (!disabled && !recording && !preparing) inputRef.current?.click();
  };

  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onAudioReady(file);
        }}
        aria-label="Choose an audio file"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(recording && "text-destructive")}
        onClick={recording ? stopRecording : startRecording}
        disabled={disabled || preparing}
        aria-label={recording ? "Stop recording" : "Record audio"}
        title={recording ? "Stop recording" : "Record audio"}
      >
        {preparing ? (
          <LoaderCircle className="animate-spin" />
        ) : recording ? (
          <Square />
        ) : (
          <Mic />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={selectFile}
        disabled={disabled || recording || preparing}
        aria-label="Attach audio"
        title="Attach audio"
      >
        <Paperclip />
      </Button>
    </div>
  );
}
