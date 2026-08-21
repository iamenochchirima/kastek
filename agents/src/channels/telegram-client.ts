export interface TelegramBotProfile {
  id: number;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface TelegramSendResult {
  providerMessageId?: string;
  status: "sent" | "unknown";
}

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export interface TelegramBotClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TelegramBotClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: TelegramBotClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public getWebhookUrl(baseUrl: string, connectionId: string): string {
    return `${baseUrl.replace(/\/$/, "")}/api/webhooks/telegram/${encodeURIComponent(connectionId)}`;
  }

  public async getMe(token: string): Promise<TelegramBotProfile> {
    const result = await this.call<{ id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }>(token, "getMe");
    if (!result.is_bot || !Number.isSafeInteger(result.id) || !result.first_name) throw new Error("Telegram token does not identify a bot");
    return {
      id: result.id,
      isBot: result.is_bot,
      firstName: result.first_name,
      ...(result.last_name ? { lastName: result.last_name } : {}),
      ...(result.username ? { username: result.username } : {}),
    };
  }

  public async setWebhook(token: string, url: string, secretToken: string): Promise<void> {
    await this.call(token, "setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
  }

  public async deleteWebhook(token: string): Promise<void> {
    await this.call(token, "deleteWebhook", { drop_pending_updates: false });
  }

  public async sendMessage(token: string, chatId: string, text: string): Promise<TelegramSendResult> {
    const result = await this.call<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text });
    return { providerMessageId: String(result.message_id), status: "sent" };
  }

  private async call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const payload = await response.json() as TelegramApiResponse<T>;
      if (!response.ok || !payload.ok || payload.result === undefined) {
        throw Object.assign(new Error(payload.description || `Telegram ${method} request failed`), {
          code: "telegram_api_error",
          statusCode: response.status >= 400 && response.status < 500 ? 400 : 502,
        });
      }
      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
