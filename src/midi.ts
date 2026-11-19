// The Web MIDI layer: listens to every input of a MIDIAccess, keeps each knob's state, sends endless
// knobs back to the centre through the device's output port, and emits turns.
// It never asks for MIDI access itself, except in requestMidiAccess().

import { decodeRelative, type Encoding } from './encoding.ts'
import { exponential, linear, wrap, type Scale } from './scale.ts'
import { defaults, recentre, shouldRecentre, turnBy, turnTo, type Acceleration, type KnobState, type Motion, type RecentreOptions, type Turn } from './turn.ts'

/** A Control Change message from a knob, and what it means. */
export interface MidiTurn extends Omit<Turn, 'state'> {
  /** Control Change number, 0–127. */
  readonly cc: number
  /** MIDI channel, 0–15. */
  readonly channel: number
  /** The value the knob sent, 0–127. */
  readonly value: number
  /** When the message arrived, in ms (its event's timeStamp). */
  readonly time: number
  /** Whether the knob was sent back to the centre after this message. */
  readonly recentred: boolean
  /** The port the message came from. */
  readonly input: MIDIInput
}

/** Something that can stop. */
export interface Disposable {
  /** Stops listening. Safe to call more than once. */
  readonly dispose: () => void
}

/** A setting for every knob, or one chosen for each CC and channel. */
export type PerKnob<T> = T | ((cc: number, channel: number) => T)

export interface ListenOptions extends Acceleration, RecentreOptions {
  /** Called for every Control Change. */
  readonly onTurn: (turn: MidiTurn) => void
  /** How knobs send their values. Default `'absolute'`. */
  readonly encoding?: PerKnob<Encoding>
  /** Send absolute knobs back to the centre near either end, so they never run out. Default false. */
  readonly endless?: PerKnob<boolean>
  /** Only this CC. Default every CC. */
  readonly cc?: number
  /** Only this channel, 0–15. Default every channel. */
  readonly channel?: number
  /** Only inputs for which this is true. Default every input. */
  readonly input?: (input: MIDIInput) => boolean
}

const CONTROL_CHANGE = 0xb0

const resolve = <T>(setting: PerKnob<T>, cc: number, channel: number): T =>
  typeof setting === 'function' ? (setting as (cc: number, channel: number) => T)(cc, channel) : setting

const isKnobState = (state: Motion | undefined): state is KnobState => state !== undefined && 'value' in state

/** The output port of the device `input` belongs to: the one with the same name and manufacturer. */
export function outputFor(access: MIDIAccess, input: MIDIInput): MIDIOutput | undefined {
  return [...access.outputs.values()].find((output) => output.name === input.name && output.manufacturer === input.manufacturer)
}

// Sends `data` to the device `input` belongs to; false if it has no output port or sending failed
const sendBack = (access: MIDIAccess, input: MIDIInput, data: readonly number[]): boolean => {
  const output = outputFor(access, input)
  if (!output) return false
  try {
    output.send(data)
    return true
  } catch {
    return false // the port went away; the knob keeps working without the reset
  }
}

/**
 * Listens to every input of `access`, including devices plugged in later, and calls `onTurn` for
 * each Control Change with its accelerated step, raw delta, speed and rate. State is kept per input,
 * channel and CC. Steps are in your units, between `fine` and `coarse` per value.
 */
export function listen(access: MIDIAccess, options: ListenOptions): Disposable {
  const { onTurn, encoding = 'absolute', endless = false } = options
  const { centre = defaults.centre } = options
  const states = new Map<string, Motion>()
  const listeners = new Map<MIDIInput, (event: MIDIMessageEvent) => void>()

  const handle = (input: MIDIInput, event: MIDIMessageEvent): void => {
    const [status = 0, cc, value] = event.data ?? []
    if ((status & 0xf0) !== CONTROL_CHANGE || cc === undefined || value === undefined) return
    const channel = status & 0x0f
    if ((options.cc ?? cc) !== cc || (options.channel ?? channel) !== channel) return

    const time = event.timeStamp || performance.now()
    const key = `${input.id}/${channel}/${cc}`
    const previous = states.get(key)
    const knobEncoding = resolve(encoding, cc, channel)

    if (knobEncoding !== 'absolute') {
      const { state, ...turn } = turnBy(previous, decodeRelative(value, knobEncoding), time, options)
      states.set(key, state)
      onTurn({ ...turn, cc, channel, value, time, recentred: false, input })
      return
    }

    const { state, ...turn } = turnTo(isKnobState(previous) ? previous : undefined, value, time, options)
    const recentred = resolve(endless, cc, channel)
      && shouldRecentre(state, options)
      && sendBack(access, input, [CONTROL_CHANGE | channel, cc, centre])
    states.set(key, recentred ? recentre(state, options) : state)
    onTurn({ ...turn, cc, channel, value, time, recentred, input })
  }

  const attach = (): void => {
    access.inputs.forEach((input) => {
      if (listeners.has(input) || (options.input && !options.input(input))) return
      const listener = (event: MIDIMessageEvent): void => handle(input, event)
      input.addEventListener('midimessage', listener)
      listeners.set(input, listener)
    })
  }

  attach()
  access.addEventListener('statechange', attach)

  return {
    dispose: () => {
      access.removeEventListener('statechange', attach)
      listeners.forEach((listener, input) => input.removeEventListener('midimessage', listener))
      listeners.clear()
      states.clear()
    },
  }
}

export interface KnobOptions extends Acceleration, RecentreOptions {
  /** The knob's Control Change number. */
  readonly cc: number
  /** Only this channel, 0–15. Default every channel. */
  readonly channel?: number
  /** Only inputs for which this is true. Default every input. */
  readonly input?: (input: MIDIInput) => boolean
  /** The starting value. */
  readonly value: number
  readonly min: number
  readonly max: number
  /**
   * How a step changes the value. Default `'linear'`.
   * - `'linear'`: adds the step, within min..max.
   * - `'exponential'`: steps are cents (1200 doubles the value), within min..max; min must be above 0.
   * - `'wrap'`: adds the step, going round from max to min, for angles and phase.
   * - or a function of your own: (value, step, min, max) => new value.
   */
  readonly scale?: 'linear' | 'exponential' | 'wrap' | Scale
  /** How the knob sends its value. Default `'absolute'`. */
  readonly encoding?: Encoding
  /** Send the knob back to the centre near either end, so it never runs out. Default true. */
  readonly endless?: boolean
  /** Called when a turn changes the value. */
  readonly onChange?: (value: number, turn: MidiTurn) => void
}

/** A value turned by a MIDI knob. */
export interface Knob extends Disposable {
  /** The current value. */
  readonly value: number
  /** Sets the value (kept within the range) without calling `onChange`; turns carry on from it. */
  readonly set: (value: number) => void
}

const scales: Readonly<Record<'linear' | 'exponential' | 'wrap', Scale>> = { linear, exponential, wrap }

/**
 * A value between `min` and `max` that the knob on `cc` turns, with acceleration, and endlessly
 * unless `endless` is false. Calls `onChange` with the new value and the turn that made it.
 */
export function knob(access: MIDIAccess, options: KnobOptions): Knob {
  const { value, min, max, scale = 'linear', endless = true, onChange, ...rest } = options
  if (!(min < max)) throw new RangeError(`knob needs min below max, got ${min}..${max}`)
  if (scale === 'exponential' && !(min > 0)) throw new RangeError(`an exponential knob needs min above 0, got ${min}`)
  const apply = typeof scale === 'function' ? scale : scales[scale]
  const within = (next: number): number => apply(next, 0, min, max)

  let current = within(value)
  const listener = listen(access, {
    ...rest,
    endless,
    onTurn: (turn) => {
      const next = apply(current, turn.step, min, max)
      if (next === current) return
      current = next
      onChange?.(current, turn)
    },
  })

  return {
    get value() {
      return current
    },
    set: (next) => {
      current = within(next)
    },
    dispose: listener.dispose,
  }
}

/**
 * Asks the browser for MIDI access, with a clear error where Web MIDI is not available.
 * Web MIDI needs a secure context (https or localhost).
 */
export async function requestMidiAccess(options: MIDIOptions = { sysex: false }): Promise<MIDIAccess> {
  const nav: Partial<Navigator> | undefined = globalThis.navigator
  if (typeof nav?.requestMIDIAccess !== 'function') {
    throw new Error(globalThis.isSecureContext === false
      ? 'Web MIDI is not available: the page is not a secure context. Serve it over https or from localhost.'
      : 'Web MIDI is not available in this browser. It works in Chrome, Edge and Opera, and in Firefox after a permission prompt.')
  }
  return nav.requestMIDIAccess(options)
}
