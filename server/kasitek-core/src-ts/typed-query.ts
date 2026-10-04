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
