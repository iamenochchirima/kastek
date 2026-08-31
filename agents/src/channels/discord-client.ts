export interface DiscordBotProfile {
  id: string;
  username: string;
  globalName?: string;
}

export interface DiscordSendResult {
  providerMessageId?: string;
  status: "sent" | "unknown";
}

export interface DiscordDownloadedAttachment {
  bytes: Uint8Array;
}

export interface DiscordComponentButton {
  customId: string;
  label: string;
  style?: "success" | "danger";
}

interface DiscordApiError {
  message?: string;
  code?: string | number;
}

export interface DiscordBotClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Small REST client used by durable activities and the Discord Gateway. */
export class DiscordBotClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: DiscordBotClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://discord.com/api/v10").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public async getMe(token: string): Promise<DiscordBotProfile> {
    const result = await this.call<Record<string, unknown>>(token, "/users/@me", { method: "GET" });
    if (typeof result.id !== "string" || typeof result.username !== "string" || result.bot !== true) {
      throw new Error("Discord token does not identify a bot");
    }
    return {
      id: result.id,
      username: result.username,
      ...(typeof result.global_name === "string" ? { globalName: result.global_name } : {}),
    };
  }

  public async getGatewayUrl(token: string): Promise<string> {
    const result = await this.call<{ url?: unknown }>(token, "/gateway/bot", { method: "GET" });
    if (typeof result.url !== "string" || !result.url) throw new Error("Discord Gateway URL was not returned");
    return result.url;
  }

  public async sendMessage(token: string, channelId: string, text: string, options: { buttons?: DiscordComponentButton[] } = {}): Promise<DiscordSendResult> {
    const components = options.buttons?.length
      ? [{ type: 1, components: options.buttons.slice(0, 5).map((button) => ({ type: 2, style: button.style === "danger" ? 4 : 3, label: button.label.slice(0, 80), custom_id: button.customId })) }]
      : undefined;
    const result = await this.call<{ id?: unknown }>(token, `/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text, ...(components ? { components } : {}) }),
    });
    return { providerMessageId: typeof result.id === "string" ? result.id : undefined, status: "sent" };
  }

  public async sendMediaResponse(
    token: string,
    channelId: string,
    text: string,
    media: readonly ResolvedAgentMedia[],
    options: { buttons?: DiscordComponentButton[] } = {},
  ): Promise<DiscordSendResult> {
    if (!media.length) return this.sendMessage(token, channelId, text, options);
    const imageEmbeds = media
      .filter((item) => item.kind === "image")
      .map((item) => ({ image: { url: item.previewUrl }, ...(item.fileName ? { title: item.fileName } : {}) }));
    const links = media
      .filter((item) => item.kind !== "image")
      .map((item) => `[${item.fileName || "Attachment"}](${item.previewUrl})`);
    const content = [text.trim(), ...links].filter(Boolean).join("\n\n");
    const components = options.buttons?.length
      ? [{ type: 1, components: options.buttons.slice(0, 5).map((button) => ({ type: 2, style: button.style === "danger" ? 4 : 3, label: button.label.slice(0, 80), custom_id: button.customId })) }]
      : undefined;
    const result = await this.call<{ id?: unknown }>(token, `/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: content || undefined, ...(imageEmbeds.length ? { embeds: imageEmbeds.slice(0, 10) } : {}), ...(components ? { components } : {}) }),
    });
    return { providerMessageId: typeof result.id === "string" ? result.id : undefined, status: "sent" };
  }

  public async downloadAttachment(token: string, url: string, maxBytes = 25 * 1024 * 1024): Promise<DiscordDownloadedAttachment> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { authorization: `Bot ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`Discord attachment download failed (${response.status})`), { code: "discord_attachment_download_failed", statusCode: 502 });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error("Discord attachment is larger than the allowed limit"), { code: "discord_attachment_too_large", statusCode: 400 });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw Object.assign(new Error("Discord attachment is larger than the allowed limit"), { code: "discord_attachment_too_large", statusCode: 400 });
      return { bytes };
    } finally {
      clearTimeout(timeout);
    }
  }

  public async sendApprovalPrompt(token: string, channelId: string, text: string, actions: { approve: string; reject: string }): Promise<DiscordSendResult> {
    return this.sendMessage(token, channelId, text, {
      buttons: [
        { customId: actions.approve, label: "Approve", style: "success" },
        { customId: actions.reject, label: "Deny", style: "danger" },
      ],
    });
  }

  /** A component interaction must be acknowledged within Discord's short deadline. */
  public async deferComponent(interactionId: string, interactionToken: string): Promise<void> {
    await this.postInteractionCallback(interactionId, interactionToken, { type: 5, data: { flags: 64 } });
  }

  public async acknowledgeComponent(interactionId: string, interactionToken: string, text: string): Promise<void> {
    await this.postInteractionCallback(interactionId, interactionToken, { type: 4, data: { content: text.slice(0, 2_000), flags: 64 } });
  }

  public async editOriginalResponse(applicationId: string, interactionToken: string, text: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, 2_000) }),
        signal: controller.signal,
      });
      if (!response.ok) await this.throwApiError(response, "Discord component response update failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postInteractionCallback(interactionId: string, interactionToken: string, body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) await this.throwApiError(response, "Discord component acknowledgement failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async call<T>(token: string, path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bot ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        signal: controller.signal,
      });
      if (!response.ok) await this.throwApiError(response, "Discord API request failed");
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async throwApiError(response: Response, fallback: string): Promise<never> {
    let detail: DiscordApiError = {};
    try { detail = await response.json() as DiscordApiError; } catch { /* provider may return an empty body */ }
    throw Object.assign(new Error(detail.message || fallback), {
      code: "discord_api_error",
      statusCode: response.status >= 400 && response.status < 500 ? 400 : 502,
      providerCode: detail.code,
    });
  }
}
import type { ResolvedAgentMedia } from "../media/delivery";
