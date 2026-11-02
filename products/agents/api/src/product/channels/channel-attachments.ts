import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { channelAttachmentSchema, type ChannelAttachment } from "../../contracts/channel-adapters";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import type { ChannelStore } from "./channel-store";

export interface ChannelAttachmentOptions {
  /** Trusted server transport bounds duration/response sizes, rejects private addresses and never logs credential-bearing URLs. */
  fetch: typeof fetch;
  maximumBytes: number;
  /** Reviewed provider CDN suffixes, for example fbsbx.com, fbcdn.net and cdninstagram.com. Empty denies all direct CDN URLs. */
  mediaHostSuffixes: readonly string[];
}
export interface StaffChannelAttachment { body: Buffer; contentType: string; fileName: string }
const failure = (code: string, status = 409) => new PlatformError(code, status, "Attachment is unavailable");

/** Resolves canonical attachment indices for authenticated staff. No provider locator enters a public DTO or model prompt. */
export class ChannelAttachments {
  constructor(private readonly channels: ChannelStore, private readonly options: ChannelAttachmentOptions) {
    z.number().int().positive().max(100 * 1024 * 1024).parse(options.maximumBytes);
    z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/)).parse(options.mediaHostSuffixes);
  }
  private async source(scope: ActionScope, conversationId: string, messageId: string, index: number) {
    return transaction(this.channels.pool, async db => {
      await requireActionMember(db, scope);
      const row = (await db.query(`SELECT n.*,f.attachments FROM agents_platform.customer_conversations c
        JOIN agents_platform.customer_messages m ON m.conversation_id=c.id JOIN agents_platform.channel_message_facts f ON f.message_id=m.id
        JOIN agents_platform.channel_connections n ON n.id=f.connection_id AND n.organization_id=c.organization_id
        JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id AND d.connection_id=n.id
        WHERE c.organization_id=$1 AND c.id=$2 AND m.id=$3 AND m.author_kind='visitor' AND n.state='active' FOR SHARE OF c,m,f,n,d`, [scope.organizationId, conversationId, messageId])).rows[0];
      if (!row) throw failure("CHANNEL_ATTACHMENT_NOT_FOUND", 404);
      if (row.metadata.evaluationFixture || row.metadata.evaluationTrialId) throw failure("CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED", 403);
      const attachment = channelAttachmentSchema.safeParse(Array.isArray(row.attachments) ? row.attachments[index] : undefined);
      if (!attachment.success) throw failure("CHANNEL_ATTACHMENT_NOT_FOUND", 404);
      return { connection: row, attachment: attachment.data };
    });
  }
  private cdn(raw: unknown): string {
    let url: URL; try { url = new URL(z.string().min(1).max(16384).parse(raw)); } catch { throw failure("CHANNEL_ATTACHMENT_URL_DENIED", 400); }
    if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash ||
      !this.options.mediaHostSuffixes.some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) throw failure("CHANNEL_ATTACHMENT_URL_DENIED", 400);
    return url.href;
  }
  private async json(url: string, init: RequestInit): Promise<Record<string, any>> {
    let response: Response; try { response = await this.options.fetch(url, { ...init, redirect: "error" }); } catch { throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE", 502); }
    let data: any; try { data = await response.json(); } catch { throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE", 502); }
    if (!response.ok || !data || typeof data !== "object" || data.error) throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE", 502);
    return data;
  }
  private checkSize(size: unknown): void {
    if (typeof size === "number" && (!Number.isSafeInteger(size) || size < 0 || size > this.options.maximumBytes)) throw failure("CHANNEL_ATTACHMENT_TOO_LARGE", 413);
  }
  private async resolve(connection: Record<string, any>, attachment: ChannelAttachment, credentials: Record<string, string>): Promise<{ url: string; headers?: Record<string, string> }> {
    if (connection.kind === "whatsapp") {
      if (!attachment.providerMediaId || !/^v\d+\.\d+$/.test(connection.metadata.apiVersion ?? "") || !/^\d+$/.test(connection.asset_id)) throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE");
      const authorization = `Bearer ${credentials.accessToken}`, url = new URL(`https://graph.facebook.com/${connection.metadata.apiVersion}/${encodeURIComponent(attachment.providerMediaId)}`);
      url.searchParams.set("phone_number_id", connection.asset_id);
      const media = await this.json(url.href, { headers: { authorization } }); this.checkSize(media.file_size);
      if (media.id !== undefined && media.id !== attachment.providerMediaId) throw failure("CHANNEL_ATTACHMENT_SCOPE_MISMATCH", 502);
      return { url: this.cdn(media.url), headers: { authorization } };
    }
    if (connection.kind === "telegram") {
      const token = z.string().regex(/^\d+:[A-Za-z0-9_-]{1,256}$/).parse(credentials.botToken);
      if (!attachment.providerMediaId || token.split(":")[0] !== connection.asset_id) throw failure("CHANNEL_ATTACHMENT_SCOPE_MISMATCH");
      const response = await this.json(`https://api.telegram.org/bot${token}/getFile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: attachment.providerMediaId }) });
      if (response.ok !== true || typeof response.result?.file_path !== "string" || response.result.file_id !== attachment.providerMediaId) throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE", 502);
      this.checkSize(response.result.file_size);
      const path: string = response.result.file_path;
      if (path.length > 2048 || path.split("/").some(segment => !segment || segment === "." || segment === ".." || /[\u0000-\u0020\u007f?#%\\]/.test(segment))) throw failure("CHANNEL_ATTACHMENT_URL_DENIED", 400);
      return { url: `https://api.telegram.org/file/bot${token}/${path.split("/").map(encodeURIComponent).join("/")}` };
    }
    if (connection.kind === "facebook" || connection.kind === "instagram") return { url: this.cdn(attachment.url) };
    throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE");
  }
  async download(scope: ActionScope, raw: unknown): Promise<StaffChannelAttachment> {
    const input = z.strictObject({ conversationId: z.uuid(), messageId: z.uuid(), index: z.number().int().min(0).max(15) }).parse(raw);
    const { connection, attachment } = await this.source(scope, input.conversationId, input.messageId, input.index);
    const credentials = await this.channels.resolveCredential({ organizationId: scope.organizationId, connectionId: connection.id,
      expectedRevision: connection.revision, credentialRevision: connection.credential_revision });
    const resource = await this.resolve(connection, attachment, credentials);
    let response: Response; try { response = await this.options.fetch(resource.url, { redirect: "error", headers: resource.headers }); } catch { throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE", 502); }
    if (!response.ok || !response.body || response.redirected) { await response.body?.cancel(); throw failure("CHANNEL_ATTACHMENT_PROVIDER_UNAVAILABLE", 502); }
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length)) { try { this.checkSize(Number(length)); } catch (error) { await response.body.cancel(); throw error; } }
    const contentType = (response.headers.get("content-type") ?? attachment.mimeType ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) || /(?:html|javascript|svg|xml)/.test(contentType)) { await response.body.cancel(); throw failure("CHANNEL_ATTACHMENT_CONTENT_UNSUPPORTED", 415); }
    const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength;
      if (bytes > this.options.maximumBytes) throw failure("CHANNEL_ATTACHMENT_TOO_LARGE", 413); chunks.push(Buffer.from(item.value)); } }
    catch (error) { await reader.cancel().catch(() => {}); if (error instanceof PlatformError) throw error; throw failure("CHANNEL_ATTACHMENT_TRANSFER_FAILED", 502); }
    finally { reader.releaseLock(); }
    // Recheck access after the transfer. A revoked membership/connection cannot receive the buffered file.
    const current = await this.source(scope, input.conversationId, input.messageId, input.index);
    if (current.connection.revision !== connection.revision || current.connection.credential_revision !== connection.credential_revision || requestDigest(current.attachment) !== requestDigest(attachment)) throw failure("CHANNEL_ATTACHMENT_AUTHORITY_CHANGED");
    const fileName = (attachment.fileName ?? `attachment-${input.index + 1}`).replace(/[\u0000-\u001f\u007f/\\"]/g, "_").slice(0, 256);
    return { body: Buffer.concat(chunks, bytes), contentType, fileName };
  }
}
