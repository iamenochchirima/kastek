import { bad, type ObjectValue } from './common.js';

export function adminPage(query: ObjectValue, defaultLimit = 50, maxLimit = 200) {
  const integer = (value: unknown, fallback: number, name: string) => {
    if (value == null) return fallback;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
      bad(`${name} must be a positive integer`);
    return Number(value);
  };
  const page = integer(query.page, 1, 'page');
  const limit = Math.min(maxLimit, integer(query.limit, defaultLimit, 'limit'));
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > 10_000_000) bad('page is too large');
  return { page, limit, offset };
}
