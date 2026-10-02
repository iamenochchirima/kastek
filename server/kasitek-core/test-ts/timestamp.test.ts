import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { UtcTimestamp, installPgTimestampParsers } from '../src-ts/db.js';
import { apiJson } from '../src-ts/json.js';

test('PostgreSQL timestamps retain microseconds and chrono UTC fraction formatting', () => {
  for (const [input, expected] of [
    ['2026-01-01 12:00:00', '2026-01-01T12:00:00Z'],
    ['2026-01-01 12:00:00.123', '2026-01-01T12:00:00.123Z'],
    ['2026-01-01 12:00:00.1234', '2026-01-01T12:00:00.123400Z'],
    ['2026-01-01 12:00:00.000001', '2026-01-01T12:00:00.000001Z'],
    ['2026-01-01 12:00:00.123456+02', '2026-01-01T10:00:00.123456Z'],
  ] as const) {
    const date = new UtcTimestamp(input, input.includes('+'));
    assert.equal(date.toISOString(), expected);
    assert.equal(JSON.parse(JSON.stringify({ date })).date, expected);
    assert.equal(date.getTime(), Date.parse(expected));
  }
  installPgTimestampParsers();
  assert.equal(pg.types.getTypeParser(1082)('2026-01-01'), '2026-01-01');
  assert.equal(pg.types.getTypeParser(1114)('2026-01-01 12:00:00.123456').toJSON(), '2026-01-01T12:00:00.123456Z');
  assert.equal(apiJson({ amount: 9223372036854775807n, omitted: undefined,
    at: new UtcTimestamp('2026-01-01 12:00:00.123456', false) }),
  '{"amount":9223372036854775807,"at":"2026-01-01T12:00:00.123456Z"}');
  assert.equal(pg.types.getTypeParser(3802)('{"amount":9223372036854775807}').amount, 9223372036854775807n);
});
