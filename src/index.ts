// infinity-knobs: precise, endless MIDI knobs in the browser.
// The core (turn, encoding, scale) is pure and runs anywhere; midi.ts wires it to Web MIDI.

export {
  CENTRE,
  defaults,
  recentre,
  shouldRecentre,
  turnBy,
  turnTo,
  type Acceleration,
  type KnobState,
  type Motion,
  type RecentreOptions,
  type Turn,
} from './turn.ts'
export { decodeRelative, type Encoding, type RelativeEncoding } from './encoding.ts'
export { exponential, linear, wrap, type Scale } from './scale.ts'
export {
  knob,
  listen,
  outputFor,
  requestMidiAccess,
  type Disposable,
  type Knob,
  type KnobOptions,
  type ListenOptions,
  type MidiTurn,
  type PerKnob,
} from './midi.ts'
