// Derived readings, kept apart from index.mjs so they can be unit-tested
// against values observed from real devices (BB-V1/BB-V2 baseboards).

// DeviceState.Timestamp is Unix *seconds*, not the milliseconds Date.now()
// returns -- mixing them up yields an "age" of ~1.8 billion seconds.
export function stateAgeSeconds(timestampSeconds, nowMs) {
  return Math.max(0, nowMs / 1000 - Number(timestampSeconds));
}

// `Current` is not a live draw: idle baseboards (temperature above setpoint,
// duty cycle 0) still report 3-19 A. It reads as the heater's load current,
// so average power is load x duty cycle. Without a duty cycle there is no
// honest estimate, so this returns undefined rather than a misleading number.
export function estimatedPowerWatts(currentAmps, volts, dutyRatio) {
  if (currentAmps === undefined || volts === undefined || dutyRatio === undefined) {
    return undefined;
  }
  return Number(currentAmps) * Number(volts) * Number(dutyRatio);
}
