import { RequestExtractionError } from './error.js';

/** Read one URL-encoded query field with an explicit repeated-key policy. */
export function queryStringField(
  rawUrl: string | undefined,
  field: string,
  repeated: 'last' | 'reject' = 'last',
): string | undefined {
  const params = new URLSearchParams(rawUrl?.split('?').slice(1).join('?') ?? '');
  let value: string | undefined;
  for (const [key, current] of params) {
    if (key !== field) continue;
    if (value !== undefined && repeated === 'reject')
      throw new RequestExtractionError('query', `duplicate field \`${field}\``);
    value = current;
  }
  return value;
}

export function requiredUniqueQueryStringField(
  rawUrl: string | undefined,
  field: string,
): string {
  const value = queryStringField(rawUrl, field, 'reject');
  if (value === undefined)
    throw new RequestExtractionError('query', `missing field \`${field}\``);
  return value;
}
