import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { UtcTimestamp, installPgTimestampParsers } from '../src/db.js';
import { apiJson } from '../src/json.js';

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
  assert.equal(pg.types.getTypeParser(1184)('2026-01-01 12:00:00.123456+02').toJSON(), '2026-01-01T10:00:00.123456Z');
  assert.equal(apiJson({ amount: 9223372036854775807n, omitted: undefined,
    at: new UtcTimestamp('2026-01-01 12:00:00.123456', false) }),
  '{"amount":9223372036854775807,"at":"2026-01-01T12:00:00.123456Z"}');
  const json = '{"amount":9223372036854775807}';
  assert.equal(pg.types.getTypeParser(114)(json).amount, 9223372036854775807n);
  assert.equal(pg.types.getTypeParser(3802)(json).amount, 9223372036854775807n);
});

test('Date query parameters remain UTC on a Johannesburg host', {skip:!process.env.CORE_TIMESTAMP_TEST_DATABASE_URL}, async()=>{
  const previous=process.env.TZ;
  const pool=new pg.Pool({connectionString:process.env.CORE_TIMESTAMP_TEST_DATABASE_URL!,options:'-c timezone=UTC'});
  try {
    process.env.TZ='Africa/Johannesburg';
    installPgTimestampParsers();
    const row=(await pool.query('SELECT $1::timestamp AS naive, $1::timestamptz AS zoned',[new Date('2026-01-01T00:00:00.123Z')])).rows[0];
    assert.equal(row.naive.toISOString(),'2026-01-01T00:00:00.123Z');
    assert.equal(row.zoned.toISOString(),'2026-01-01T00:00:00.123Z');
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;await pool.end();}
});
