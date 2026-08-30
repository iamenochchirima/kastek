import { formatTelegramText } from "./formatting";

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

export interface TelegramDownloadedFile {
  bytes: Uint8Array;
  filePath: string;
}

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

function isRichMessageFallbackError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (statusCode !== 400) return false;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return /rich|method|parse|markdown|unsupported|entity/.test(message);
}

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
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  }

  public async deleteWebhook(token: string): Promise<void> {
    await this.call(token, "deleteWebhook", { drop_pending_updates: false });
  }

  public async sendMessage(token: string, chatId: string, text: string, options: { inlineButtons?: TelegramInlineButton[][] } = {}): Promise<TelegramSendResult> {
    const replyMarkup = options.inlineButtons?.length ? {
      reply_markup: {
        inline_keyboard: options.inlineButtons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))),
      },
    } : {};
    let result: { message_id: number };
    try {
      result = await this.call<{ message_id: number }>(token, "sendRichMessage", {
        chat_id: chatId,
        rich_message: { markdown: text },
        ...replyMarkup,
      });
    } catch (error) {
      if (!isRichMessageFallbackError(error)) throw error;
      result = await this.call<{ message_id: number }>(token, "sendMessage", {
        chat_id: chatId,
        text: formatTelegramText(text),
        parse_mode: "HTML",
        ...replyMarkup,
      });
    }
    return { providerMessageId: String(result.message_id), status: "sent" };
  }

  public async sendApprovalPrompt(token: string, chatId: string, text: string, actions: { approve: string; reject: string }): Promise<TelegramSendResult> {
    return this.sendMessage(token, chatId, text, {
      inlineButtons: [[
        { text: "Approve", callbackData: actions.approve },
        { text: "Deny", callbackData: actions.reject },
      ]],
    });
  }

  public async answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
    await this.call(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text: text.slice(0, 200) } : {}),
    });
  }

  public async downloadFile(token: string, fileId: string, maxBytes = 20 * 1024 * 1024): Promise<TelegramDownloadedFile> {
    const file = await this.call<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram did not return a file path");
    if (typeof file.file_size === "number" && file.file_size > maxBytes) {
      throw Object.assign(new Error("Telegram file is larger than the allowed limit"), { code: "telegram_file_too_large", statusCode: 400 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/file/bot${token}/${file.file_path}`, { signal: controller.signal });
      if (!response.ok) {
        throw Object.assign(new Error(`Telegram file download failed (${response.status})`), {
          code: "telegram_file_download_failed",
          statusCode: response.status >= 400 && response.status < 500 ? 400 : 502,
        });
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > maxBytes) {
        throw Object.assign(new Error("Telegram file is larger than the allowed limit"), { code: "telegram_file_too_large", statusCode: 400 });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw Object.assign(new Error("Telegram file is larger than the allowed limit"), { code: "telegram_file_too_large", statusCode: 400 });
      }
      return { bytes, filePath: file.file_path };
    } finally {
      clearTimeout(timeout);
    }
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
          statusCode: !response.ok
            ? (response.status >= 400 && response.status < 500 ? 400 : 502)
            : (!payload.ok ? 400 : 502),
        });
      }
      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
