import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisWeekRange, analysisWeekEnd, analysisMonthRange, calendarDate } from '../src/time.ts';

test('Amsterdam Monday-Sunday week uses actual DST 167/169 hour ranges', () => {
  const spring = analysisWeekRange('2026-03-29');
  assert.equal(spring.from, '2026-03-22T23:00:00.000Z');
  assert.equal(spring.to, '2026-03-29T22:00:00.000Z');
  assert.equal((Date.parse(spring.to) - Date.parse(spring.from)) / 3600000, 167);
  const autumn = analysisWeekRange('2026-10-25');
  assert.equal(autumn.from, '2026-10-18T22:00:00.000Z');
  assert.equal(autumn.to, '2026-10-25T23:00:00.000Z');
  assert.equal((Date.parse(autumn.to) - Date.parse(autumn.from)) / 3600000, 169);
});
test('calendar day and week are independent of the host timezone', () => {
  assert.equal(analysisWeekEnd('2026-09-30T23:30:00Z'), '2026-10-04');
  assert.equal(calendarDate('2026-09-30T23:30:00Z', 'Europe/Amsterdam'), '2026-10-01');
  assert.throws(() => analysisWeekRange('2026-09-30'), /Sunday/);
  assert.equal(analysisMonthRange('2026-10').to, '2026-10-31T23:00:00.000Z');
});
