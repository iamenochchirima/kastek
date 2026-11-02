import { useCallback, useEffect, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import { apiUrl } from "@/lib/server-api";

type CallState =
  "idle" | "microphone" | "connecting" | "active" | "ended" | "failed";

export function useBrowserCall(onChange: () => void) {
  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState("");
  const [acceptedAt, setAcceptedAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const attempt = useRef(0);
  const device = useRef<Device | null>(null);
  const call = useRef<Call | null>(null);
  const controller = useRef<AbortController | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const busy =
    state === "microphone" || state === "connecting" || state === "active";

  const cleanup = useCallback(() => {
    attempt.current += 1;
    controller.current?.abort();
    controller.current = null;
    const oldCall = call.current;
    const oldDevice = device.current;
    call.current = null;
    device.current = null;
    oldCall?.removeAllListeners();
    oldDevice?.removeAllListeners();
    try {
      oldCall?.disconnect();
    } finally {
      oldDevice?.destroy();
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);
  useEffect(() => {
    if (!acceptedAt || state !== "active") return;
    const update = () =>
      setSeconds(Math.floor((Date.now() - acceptedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [acceptedAt, state]);

  const end = useCallback(() => {
    cleanup();
    setState("ended");
    setAcceptedAt(null);
    change.current();
  }, [cleanup]);

  async function start(connectionId: string, destination: string) {
    // This ref guard covers repeated clicks before React commits the pending state.
    if (controller.current || device.current || call.current) return;
    cleanup();
    const id = attempt.current;
    const pending = new AbortController();
    controller.current = pending;
    setError("");
    setAcceptedAt(null);
    setSeconds(0);
    setState("microphone");
    const current = () => id === attempt.current;
    const fail = (message: string) => {
      if (!current()) return;
      cleanup();
      setError(message);
      setState("failed");
      change.current();
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Microphone access is unavailable in this browser.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!current()) return;
      setState("connecting");
      const response = await fetch(apiUrl("/api/calls/twilio/browser-token"), {
        method: "POST",
        credentials: "include",
        signal: pending.signal,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Could not start browser calling");
      if (!current()) return;
      const { Device: TwilioDevice } = await import("@twilio/voice-sdk");
      if (!current()) return;
      const nextDevice = new TwilioDevice(payload.token);
      device.current = nextDevice;
      nextDevice.on("error", (event) =>
        fail(event.message || "The browser call failed"),
      );
      const nextCall = await nextDevice.connect({
        params: { To: destination, ConnectionId: connectionId },
      });
      if (!current()) {
        nextCall.disconnect();
        nextDevice.destroy();
        return;
      }
      call.current = nextCall;
      nextCall.on("accept", () => {
        if (!current()) return;
        setAcceptedAt(Date.now());
        setState("active");
        change.current();
      });
      for (const event of ["disconnect", "cancel", "reject"] as const) {
        nextCall.on(event, () => {
          if (current()) end();
        });
      }
      nextCall.on("error", (event) =>
        fail(event.message || "The browser call failed"),
      );
    } catch (event) {
      const denied =
        event instanceof DOMException && event.name === "NotAllowedError";
      fail(
        denied
          ? "Microphone access denied. Allow microphone access and try again."
          : event instanceof Error
            ? event.message
            : "Could not start browser calling",
      );
    }
  }
  return { state, error, busy, seconds, start, end };
}
