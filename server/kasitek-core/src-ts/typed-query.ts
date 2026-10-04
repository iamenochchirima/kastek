import { RequestExtractionError } from './error.js';

/** Validate fields accepted by Actix `Query<T>` without rejecting unknown keys. */
export function typedQuery<T extends object>(
  value: unknown,
  fields: readonly (keyof T & string)[],
): T {
  const source =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const result: Record<string, string | undefined> = {};

  for (const field of fields) {
    const entry = source[field];
    if (entry === undefined) continue;
    if (Array.isArray(entry))
      throw new RequestExtractionError(
        'query',
        'duplicate field `' + field + '`',
      );
    if (typeof entry !== 'string')
      throw new RequestExtractionError('query', 'invalid query field type');
    result[field] = entry;
  }

  return result as T;
}

/** Parse a Rust `i64` encoded as an Actix query-string value. */
export function queryI64(
  value: string | undefined,
  field: string,
  required = false,
): bigint | undefined {
  if (value === undefined) {
    if (required)
      throw new RequestExtractionError('query', `missing field \`${field}\``);
    return undefined;
  }
  if (!/^[-+]?\d+$/.test(value))
    throw new RequestExtractionError(
      'query',
      value
        ? 'invalid digit found in string'
        : 'cannot parse integer from empty string',
    );
  const parsed = BigInt(value);
  if (parsed < -(1n << 63n))
    throw new RequestExtractionError(
      'query',
      'number too small to fit in target type',
    );
  if (parsed >= 1n << 63n)
    throw new RequestExtractionError(
      'query',
      'number too large to fit in target type',
    );
  return parsed;
}

/** Read an optional/required string field from an already validated query. */
export function queryString(
  value: string | undefined,
  field: string,
  required = false,
): string | undefined {
  if (value === undefined && required)
    throw new RequestExtractionError('query', `missing field \`${field}\``);
  return value;
}

/** Parse a Rust `u64`/64-bit `usize` encoded as an Actix query-string value. */
export function queryU64(
  value: string | undefined,
  field: string,
  required = false,
): bigint | undefined {
  if (value === undefined) {
    if (required)
      throw new RequestExtractionError('query', `missing field \`${field}\``);
    return undefined;
  }
  if (!/^\+?\d+$/.test(value))
    throw new RequestExtractionError(
      'query',
      value
        ? 'invalid digit found in string'
        : 'cannot parse integer from empty string',
    );
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n)
    throw new RequestExtractionError(
      'query',
      'number too large to fit in target type',
    );
  return parsed;
}
