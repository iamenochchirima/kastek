import type { ModelFailureDiagnostics } from "../../contracts/model-transport";

type Diagnostic = Pick<ModelFailureDiagnostics, "streamErrorKind" | "providerErrorCode">;
const frameLimit = 16_384;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Observe bounded SSE framing without rewriting bytes or retaining provider error text. */
export function observeSseFailures(responses = false) {
  const line = new Uint8Array(frameLimit);
  let length = 0, frameBytes = 0, firstLine = true, previousCR = false, limited = false, stopped = false;
  let data: string[] = [], event: string | undefined, diagnostic: Diagnostic | undefined;
  const reset = () => { length = 0; frameBytes = 0; data = []; event = undefined; };
  const dispatch = () => {
    if (stopped || limited || diagnostic || !event && !data.length) { reset(); return; }
    const payload = data.join("\n"), name = event;
    reset();
    if (payload === "[DONE]") { stopped = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(payload); }
    catch { diagnostic = { streamErrorKind: "malformed_sse_json" }; return; }
    // The OpenAI SDK treats thread events separately from ordinary API error envelopes.
    if (name?.startsWith("thread.")) return;
    if (name === "error" || object(parsed) && (parsed.error || responses && parsed.type === "error")) {
      const error = object(parsed) && object(parsed.error) ? parsed.error : parsed;
      const candidates = [object(error) ? error.status : undefined, object(parsed) ? parsed.status : undefined,
        object(error) ? error.code : undefined];
      const code = candidates.find(value => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
      diagnostic = { streamErrorKind: "upstream_sse_error",
        ...(typeof code === "number" ? { providerErrorCode: code } : {}) };
    }
  };
  const finishLine = () => {
    let text = Buffer.from(line.subarray(0, length)).toString("utf8");
    length = 0;
    if (firstLine) { firstLine = false; if (text.startsWith("\uFEFF")) text = text.slice(1); }
    if (!text) { dispatch(); return; }
    if (text.startsWith(":")) return;
    const separator = text.indexOf(":"), field = separator < 0 ? text : text.slice(0, separator);
    let value = separator < 0 ? "" : text.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };
  return {
    write(bytes: Uint8Array) {
      if (limited || stopped || diagnostic) return;
      try {
        for (const byte of bytes) {
          if (byte === 10 && previousCR) { previousCR = false; continue; }
          previousCR = false;
          if (byte === 10 || byte === 13) {
            finishLine(); previousCR = byte === 13;
            if (stopped || diagnostic) return;
          } else {
            if (++frameBytes > frameLimit) { limited = true; reset(); return; }
            line[length++] = byte;
          }
        }
      } catch { limited = true; reset(); }
    },
    finish() {
      if (limited || stopped || diagnostic) return;
      // EOF is not an SSE event delimiter. Discard an unterminated line or frame;
      // only the blank line in finishLine() is allowed to dispatch an event.
      reset();
    },
    diagnostic(): Diagnostic { return diagnostic ?? { streamErrorKind: "unclassified" }; },
  };
}
