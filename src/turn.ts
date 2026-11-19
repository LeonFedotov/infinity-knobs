// Speed-sensitive acceleration and endless recentring for 7-bit MIDI knobs.
// Pure functions: no DOM, no Web MIDI, no clock. Times are milliseconds from any clock.

/** The defaults, calibrated on an Akai MPD218. */
export const defaults: Readonly<{
  /** Values a second at which a knob reaches its coarse step. */
  fastRate: number
  /** After a pause this long (ms), a knob's speed starts again from rest. */
  pauseMs: number
  /** The value an endless knob is sent back to. */
  centre: number
  /** An endless knob is sent back to the centre when it gets this close to 0 or 127. */
  margin: number
}> = Object.freeze({ fastRate: 400, pauseMs: 250, centre: 64, margin: 16 })

/** The value an endless knob is sent back to: 64, the middle of 0–127. */
export const CENTRE: number = defaults.centre

/** Highest value of a 7-bit Control Change. */
const MAX = 127

/** How steps grow with speed. Steps are in your units: cents, degrees, decibels… */
export interface Acceleration {
  /** Step per value when the knob turns slowly. */
  readonly fine: number
  /** Step per value when the knob turns at `fastRate` or faster. */
  readonly coarse: number
  /** Values a second at which the step reaches `coarse`. Default 400. */
  readonly fastRate?: number
  /** After a pause this long (ms), the speed starts again from rest. Default 250. */
  readonly pauseMs?: number
}

/** Where endless knobs are sent back to, and when. */
export interface RecentreOptions {
  /** The value a knob is sent back to. Default 64. */
  readonly centre?: number
  /** Send a knob back when it is this close to 0 or 127. Default 16. */
  readonly margin?: number
}

/** How fast a knob was turning at its last message. */
export interface Motion {
  /** Time of the last message, in ms. */
  readonly time: number
  /** Smoothed speed in values a second. */
  readonly rate: number
}

/** The state of an absolute (0–127) knob after its last message. */
export interface KnobState extends Motion {
  /** Where the knob is, as far as we know: its last value, or the centre after a reset. */
  readonly value: number
  /** Set while a reset is on its way to the controller: the last value the knob sent from before it. */
  readonly recentredFrom?: number
}

/** One message's worth of movement. */
export interface Turn<State extends Motion = KnobState> {
  /** Keep this and pass it with the knob's next message. */
  readonly state: State
  /** Values moved since the last message, signed. */
  readonly delta: number
  /** The accelerated step in your units: `delta` times a step between `fine` and `coarse`. */
  readonly step: number
  /** How fast the knob is turning, from 0 (at rest) to 1 (at `fastRate` or faster). */
  readonly speed: number
  /** Smoothed speed in values a second. */
  readonly rate: number
}

type Accelerated = Omit<Turn<Motion>, 'state' | 'delta'>

// The speed of a move of `delta` values at `time`, and the step it makes
const accelerate = (previous: Motion | undefined, delta: number, time: number, acceleration: Acceleration): Accelerated => {
  const { fine, coarse, fastRate = defaults.fastRate, pauseMs = defaults.pauseMs } = acceleration
  const elapsed = previous ? Math.max(time - previous.time, 1) : Infinity
  const instantRate = (Math.abs(delta) * 1000) / elapsed
  // Averaged with the last rate, so one burst of USB messages doesn't jump to coarse steps
  const rate = !previous || elapsed > pauseMs ? instantRate : (previous.rate + instantRate) / 2
  const speed = Math.min(1, (rate / fastRate) ** 3)
  return { step: delta * (fine + (coarse - fine) * speed), speed, rate }
}

/**
 * The turn of an absolute knob that sent `value` (0–127) at `time` (ms).
 * `state` is the knob's state from its last message, or undefined for its first, which only records
 * where the knob is, so touching a knob never makes it jump.
 * After {@link recentre}, a message the knob sent before the reset reached it is nearer its old
 * position than the centre, so it is measured from there and the knob keeps waiting for the reset.
 */
export function turnTo(state: KnobState | undefined, value: number, time: number, acceleration: Acceleration): Turn {
  if (!state) return { state: { value, time, rate: 0 }, delta: 0, step: 0, speed: 0, rate: 0 }
  const from = state.recentredFrom
  const fromBefore = from !== undefined && Math.abs(value - from) < Math.abs(value - state.value)
  const delta = value - (fromBefore ? from : state.value)
  const { step, speed, rate } = accelerate(state, delta, time, acceleration)
  const next: KnobState = fromBefore ? { value: state.value, time, rate, recentredFrom: value } : { value, time, rate }
  return { state: next, delta, step, speed, rate }
}

/**
 * The turn of a relative knob that sent a move of `delta` values at `time` (ms).
 * Decode the message first with {@link decodeRelative}. A relative knob has no position to anchor,
 * so its first message moves it too, at rest speed.
 */
export function turnBy(state: Motion | undefined, delta: number, time: number, acceleration: Acceleration): Turn<Motion> {
  const { step, speed, rate } = accelerate(state, delta, time, acceleration)
  return { state: { time, rate }, delta, step, speed, rate }
}

/**
 * Whether to send a knob back to the centre, so it never reaches 0 or 127. Only one reset is
 * outstanding at a time: this is false until the last one has arrived.
 */
export function shouldRecentre(state: KnobState, options: RecentreOptions = {}): boolean {
  const { margin = defaults.margin } = options
  return state.recentredFrom === undefined && (state.value <= margin || state.value >= MAX - margin)
}

/** The knob's state once you have sent it the centre value, remembering where it was. */
export function recentre(state: KnobState, options: RecentreOptions = {}): KnobState {
  const { centre = defaults.centre } = options
  return { ...state, value: centre, recentredFrom: state.value }
}
