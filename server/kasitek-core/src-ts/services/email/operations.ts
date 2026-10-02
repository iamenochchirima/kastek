import type { Pool } from 'pg';
import type { CoreConfig } from '../../config.js';
import { ApiError } from '../../error.js';
import {
  resolveEmailCredential,
  providerRequest,
  type HttpFetch,
} from '../../integrations/email.js';
const encodeUrl = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export type EmailOperation = 'search' | 'read' | 'send' | 'reply';
export function parseEmailOperation(value: string): EmailOperation {
  if (!['search', 'read', 'send', 'reply'].includes(value))
    throw new ApiError(400, 'bad_request', 'Unsupported email operation');
  return value as EmailOperation;
}
const string = (value: unknown) => (typeof value === 'string' ? value : null);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export async function execute(
  pool: Pool,
  config: CoreConfig,
  orgId: string,
  operation: EmailOperation,
  input: unknown,
  http: HttpFetch = fetch,
): Promise<Record<string, unknown>> {
  const values = object(input),
    row = await resolveEmailCredential(
      pool,
      orgId,
      string(values.provider),
      string(values.account),
    ),
    provider = row.provider.toLowerCase(),
    account = row.email_address;
  const request = async (method: string, path: string, body?: unknown) =>
    object(await providerRequest(pool, config, row, method, path, body, http));
  if (operation === 'search') {
    const limit = Math.min(
        50,
        Math.max(
          1,
          typeof values.limit === 'number' && Number.isSafeInteger(values.limit)
            ? values.limit
            : typeof values.limit === 'bigint' &&
                values.limit >= -(1n << 63n) &&
                values.limit < 1n << 63n
              ? Number(values.limit)
              : 10,
        ),
      ),
      query = string(values.query) ?? '';
    let payload: Record<string, unknown>;
    if (row.provider === 'GOOGLE')
      payload = await request(
        'GET',
        `/users/me/messages?q=${encodeUrl(query)}&maxResults=${limit}`,
      );
    else if (row.provider === 'MICROSOFT')
      payload = await request(
        'GET',
        `/me/messages?$top=${limit}&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview&$filter=contains(subject,'${encodeUrl(query.replaceAll("'", "''"))}')`,
      );
    else throw new ApiError(400, 'bad_request', 'Unsupported email provider');
    return {
      provider,
      account,
      messages: payload[row.provider === 'GOOGLE' ? 'messages' : 'value'] ?? [],
      accounts: [{ provider, label: account, emailAddress: account }],
      nextPageToken:
        row.provider === 'GOOGLE' ? (payload.nextPageToken ?? null) : null,
    };
  }
  const required = (key: string) => {
    const v = string(values[key]);
    if (v === null)
      throw new ApiError(400, 'bad_request', `${key} is required`);
    return v;
  };
  if (operation === 'read') {
    const id = encodeUrl(required('messageId')),
      payload = await request(
        'GET',
        row.provider === 'GOOGLE'
          ? `/users/me/messages/${id}?format=full`
          : `/me/messages/${id}?$select=id,conversationId,subject,from,toRecipients,body,receivedDateTime,isRead`,
      );
    return { provider, account, message: payload };
  }
  const body = required('body'),
    subject = string(values.subject) ?? '',
    recipients = array(values.to).filter(
      (v): v is string => typeof v === 'string',
    );
  let payload: Record<string, unknown>;
  if (row.provider === 'GOOGLE' && operation === 'reply') {
    const original = await request(
        'GET',
        `/users/me/messages/${encodeUrl(required('messageId'))}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=References`,
      ),
      headers = array(object(original.payload).headers),
      header = (name: string) => {
        const found = headers
          .map(object)
          .find((v) => string(v.name)?.toLowerCase() === name.toLowerCase());
        return found ? (string(found.value) ?? '') : null;
      },
      to = recipients.length ? recipients.join(', ') : (header('From') ?? ''),
      originalSubject = subject || header('Subject') || '',
      replySubject = originalSubject.startsWith('Re:')
        ? originalSubject
        : `Re: ${originalSubject}`,
      lines = [`To: ${to}`, `Subject: ${replySubject}`];
    const messageId = header('Message-ID'),
      references = header('References');
    if (messageId !== null) lines.push(`In-Reply-To: ${messageId}`);
    if (references !== null) lines.push(`References: ${references}`);
    lines.push('Content-Type: text/plain; charset=UTF-8', '', body);
    payload = await request('POST', '/users/me/messages/send', {
      raw: Buffer.from(lines.join('\r\n')).toString('base64url'),
      threadId: original.threadId ?? values.threadId ?? null,
    });
  } else if (row.provider === 'GOOGLE') {
    payload = await request('POST', '/users/me/messages/send', {
      raw: Buffer.from(
        `To: ${recipients.join(', ')}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
      ).toString('base64url'),
      threadId: values.threadId ?? null,
    });
  } else if (operation === 'reply')
    payload = await request(
      'POST',
      `/me/messages/${encodeUrl(required('messageId'))}/reply`,
      { comment: body },
    );
  else
    payload = await request('POST', '/me/sendMail', {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: recipients.map((address) => ({
          emailAddress: { address },
        })),
      },
      saveToSentItems: true,
    });
  return { provider, account, status: 'sent', messageId: payload.id ?? null };
}
