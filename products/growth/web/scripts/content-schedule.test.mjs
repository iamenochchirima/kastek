import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledPostTimestamp } from '../src/lib/content-schedule.ts';

test('datetime-local scheduling preserves the selected wall time as an explicit instant', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Africa/Johannesburg';
    assert.equal(scheduledPostTimestamp('2030-01-01T09:00', 0), '2030-01-01T07:00:00.000Z');
    process.env.TZ = 'America/New_York';
    assert.equal(scheduledPostTimestamp('2030-01-01T09:00', 0), '2030-01-01T14:00:00.000Z');
    assert.throws(() => scheduledPostTimestamp('2030-02-30T09:00', 0), /valid/);
    assert.throws(() => scheduledPostTimestamp('2030-03-10T02:30', 0), /valid/);
    assert.throws(() => scheduledPostTimestamp('2000-01-01T09:00'), /future/);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
