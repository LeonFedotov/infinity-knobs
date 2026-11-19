// Applying a step to a value. Each takes (value, step, min, max) and returns the new value.

/** Applies `step` to `value` within `min..max`. */
export type Scale = (value: number, step: number, min: number, max: number) => number

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * Multiplies `value` by 2 for every `perDoubling` of `step`, within `min..max`. With the default of
 * 1200, steps are cents, which suits frequencies. `min` must be above 0; a value of 0 becomes `min`.
 */
export function exponential(value: number, step: number, min: number, max: number, perDoubling = 1200): number {
  return clamp(value * 2 ** (step / perDoubling), min, max)
}

/** Adds `step` to `value`, within `min..max`. */
export function linear(value: number, step: number, min: number, max: number): number {
  return clamp(value + step, min, max)
}

/** Adds `step` to `value`, going round from `max` to `min` and back, for angles and phase. */
export function wrap(value: number, step: number, min: number, max: number): number {
  const span = max - min
  const offset = (value + step - min) % span
  const positive = offset < 0 ? offset + span : offset
  return min + (positive < span ? positive : 0) // rounding can land a tiny negative offset on `max`
}
