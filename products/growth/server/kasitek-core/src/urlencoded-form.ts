import type { FastifyRequest } from 'fastify';
import { RequestExtractionError } from './error.js';

export const URLENCODED_FORM_BODY_LIMIT = 16_384;

export function requireUrlencodedForm(request: FastifyRequest): void {
  const contentType = request.headers['content-type'];
  const headerValue = typeof contentType === 'string' ? contentType : '';
  const mediaType = (headerValue.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    throw new RequestExtractionError('form', 'Content type error.', 415);
  }
}

export function requiredFormField(request: FastifyRequest, name: string): string {
  const body = request.body;
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[name]
    : undefined;
  if (Array.isArray(value)) {
    throw new RequestExtractionError('form', `Parse error: duplicate field \`${name}\`.`);
  }
  if (typeof value !== 'string') {
    throw new RequestExtractionError('form', `Parse error: missing field \`${name}\`.`);
  }
  return value;
}
