// Regression tests from values observed on real devices: a Unix-seconds
// timestamp produced an "age" of ~1.8 billion seconds, and idle baseboards
// (duty cycle 0) reported 3-19 A, which made the power estimate read
// 0.8-4.5 kW while nothing was heating.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedPowerWatts, stateAgeSeconds } from '../readings.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !~ ${expected}`);

test('state age treats the API timestamp as Unix seconds', () => {
  const nowMs = 1790282220000;
  near(stateAgeSeconds(1790282160, nowMs), 60);
  near(stateAgeSeconds('1790282160', nowMs), 60);
});

test('state age never goes negative on clock skew', () => {
  assert.equal(stateAgeSeconds(1790282300, 1790282220000), 0);
});

test('an idle heater with a stale load current estimates 0 W, not its connected load', () => {
  assert.equal(estimatedPowerWatts(18.853863, 240, 0), 0);
  assert.equal(estimatedPowerWatts(3.69, 240, 0), 0);
});

test('a heating baseboard estimates load x duty cycle', () => {
  near(estimatedPowerWatts(3.69, 240, 1), 885.6);
  near(estimatedPowerWatts(3.69, 240, 0.5), 442.8);
});

test('no estimate without a duty cycle, current, or voltage', () => {
  assert.equal(estimatedPowerWatts(3.69, 240, undefined), undefined);
  assert.equal(estimatedPowerWatts(undefined, 240, 1), undefined);
  assert.equal(estimatedPowerWatts(3.69, undefined, 1), undefined);
});
