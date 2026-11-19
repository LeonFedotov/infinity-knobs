import { test } from 'node:test'
import assert from 'node:assert/strict'
import { knob, listen, outputFor, requestMidiAccess, type ListenOptions, type MidiTurn } from '../src/midi.ts'
import { fakeMidi } from './fake-midi.ts'

const steps = { fine: 0.25, coarse: 50 }

const close = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

// Listens with steps of 0.25 and 50 (cents, for example), recording every turn
const record = (access: MIDIAccess, options: Partial<ListenOptions> = {}): { turns: MidiTurn[], dispose: () => void } => {
  const turns: MidiTurn[] = []
  const { dispose } = listen(access, { ...steps, ...options, onTurn: (turn) => turns.push(turn) })
  return { turns, dispose }
}

const deltas = (turns: readonly MidiTurn[]): number[] => turns.map((turn) => turn.delta)

test('listen turns every Control Change into a turn with its step, speed and rate', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const { turns } = record(midi.access)
  const knob3 = mpd.knob(3, 0, 60)
  knob3.turn(1, 1000) // the first message only anchors
  knob3.turn(1, 1250) // slow
  knob3.turn(7, 1260) // fast

  const [first, slow, fast] = turns
  const { input, ...fields } = first!
  assert.equal(input, mpd.input)
  assert.deepEqual(fields, { cc: 3, channel: 0, value: 61, delta: 0, step: 0, speed: 0, rate: 0, time: 1000, recentred: false })
  assert.equal(slow!.delta, 1)
  close(slow!.step, 0.25, 0.01)
  assert.equal(fast!.value, 69)
  assert.equal(fast!.delta, 7)
  close(fast!.rate, (2 + 700) / 2) // 4 values a second before, 700 now
  close(fast!.speed, (351 / 400) ** 3)
  close(fast!.step, 7 * (0.25 + (50 - 0.25) * (351 / 400) ** 3))
})

test('listen ignores messages that are not Control Changes', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const { turns } = record(midi.access)
  mpd.send([0x90, 36, 100], 1000) // a pad
  mpd.send([0xe0, 0, 64], 1000) // pitch bend
  mpd.send([0xf8], 1000) // clock
  mpd.send([0xb0, 3], 1000) // cut short
  assert.equal(turns.length, 0)
})

test('listen keeps each input, channel and CC apart', () => {
  const midi = fakeMidi()
  const a = midi.plug({ id: 'a' })
  const b = midi.plug({ id: 'b', name: 'MPD218 Port B' })
  const { turns } = record(midi.access)
  const knobs = [a.knob(3, 0, 60), a.knob(3, 1, 60), a.knob(4, 0, 60), b.knob(3, 0, 60)]
  knobs.forEach((k, i) => k.turn(1, 1000 + i))
  knobs.forEach((k, i) => k.turn([2, -3, 4, -5][i]!, 1300 + i))
  assert.deepEqual(deltas(turns.slice(0, 4)), [0, 0, 0, 0])
  assert.deepEqual(
    turns.slice(4).map((turn) => [turn.input.id, turn.channel, turn.cc, turn.delta]),
    [['a', 0, 3, 2], ['a', 1, 3, -3], ['a', 0, 4, 4], ['b', 0, 3, -5]],
  )
})

test('listen picks up devices plugged in later, once each', () => {
  const midi = fakeMidi()
  const { turns } = record(midi.access)
  const k = midi.plug().knob(3)
  k.turn(1, 1000)
  k.turn(1, 1300)
  midi.access.dispatchEvent(new Event('statechange'))
  k.turn(1, 1600)
  assert.deepEqual(deltas(turns), [0, 1, 1])
})

test('listen can keep to one CC, channel and input', () => {
  const midi = fakeMidi()
  const a = midi.plug()
  const b = midi.plug({ name: 'Other', manufacturer: 'Someone' })
  const { turns } = record(midi.access, { cc: 3, channel: 1, input: (input) => input.name === 'MPD218 Port A' })
  for (const k of [a.knob(3, 1), a.knob(3, 0), a.knob(4, 1), b.knob(3, 1)]) k.turn(1, 1000)
  assert.deepEqual(turns.map((turn) => [turn.input.name, turn.channel, turn.cc]), [['MPD218 Port A', 1, 3]])
})

test('listen leaves knobs alone unless they are endless', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  record(midi.access)
  const k = mpd.knob(3, 0, 100)
  for (let i = 0; i < 40; i++) k.turn(1, 1000 + i * 20)
  assert.equal(k.position(), 127)
  assert.deepEqual(mpd.received, [])
})

test('an endless knob is sent back to the centre near either end, so it never runs out', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const { turns } = record(midi.access, { endless: true })
  const k = mpd.knob(3, 0, 100)
  const positions: number[] = []
  for (let i = 0; i < 300; i++) {
    k.turn(1, 1000 + i * 20)
    positions.push(k.position())
  }
  for (let i = 0; i < 300; i++) {
    k.turn(-1, 7000 + i * 20)
    positions.push(k.position())
  }
  // Every message arrived and was counted, including the ones sent before a reset arrived
  assert.equal(turns.length, 600)
  assert.ok(turns.slice(1, 300).every((turn) => turn.delta === 1))
  assert.ok(turns.slice(300).every((turn) => turn.delta === -1))
  assert.ok(Math.max(...positions) <= 112 && Math.min(...positions) >= 15, `${Math.min(...positions)}..${Math.max(...positions)}`)
  assert.ok(mpd.received.length > 4)
  assert.ok(mpd.received.every((message) => message.join() === [0xb0, 3, 64].join()))
  assert.equal(turns.filter((turn) => turn.recentred).length, mpd.received.length)
})

test('an endless knob keeps every step of a hard spin', () => {
  // An MPD218 spun hard sends a message every 10 ms, 7 values apart
  const midi = fakeMidi()
  const mpd = midi.plug()
  const { turns } = record(midi.access, { endless: true })
  const k = mpd.knob(3)
  for (let i = 0; i < 200; i++) k.turn(7, 1000 + i * 10)
  for (let i = 0; i < 200; i++) k.turn(-7, 4000 + i * 10)
  assert.equal(turns.length, 400)
  assert.ok(turns.slice(1, 200).every((turn) => turn.delta === 7), deltas(turns).join())
  assert.ok(turns.slice(200).every((turn) => turn.delta === -7), deltas(turns).join())
  close(turns[199]!.step, 7 * 50)
})

test('an endless knob keeps working on a controller that ignores the reset', () => {
  const midi = fakeMidi()
  const mpd = midi.plug({ takesFeedback: false })
  const { turns } = record(midi.access, { endless: true })
  const k = mpd.knob(3, 0, 100)
  for (let i = 0; i < 40; i++) k.turn(1, 1000 + i * 20)
  // It runs into the end and goes silent, but every message it sent counted
  assert.equal(k.position(), 127)
  assert.equal(turns.length, 27)
  assert.ok(turns.slice(1).every((turn) => turn.delta === 1))
  assert.equal(mpd.received.length, 1, 'only one reset is outstanding at a time')
})

test('an endless knob keeps working on a controller without an output port', () => {
  const midi = fakeMidi()
  const mpd = midi.plug({ output: false })
  const { turns } = record(midi.access, { endless: true })
  const k = mpd.knob(3, 0, 100)
  for (let i = 0; i < 40; i++) k.turn(1, 1000 + i * 20)
  assert.equal(turns.length, 27)
  assert.ok(turns.every((turn) => !turn.recentred))
})

test('an endless knob keeps working when sending the reset fails', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  Object.assign(mpd.output!, { send: () => { throw new Error('disconnected') } })
  const { turns } = record(midi.access, { endless: true })
  const k = mpd.knob(3, 0, 100)
  for (let i = 0; i < 40; i++) k.turn(1, 1000 + i * 20)
  assert.equal(turns.length, 27)
  assert.ok(turns.every((turn) => !turn.recentred))
})

test('endless can be chosen per CC and takes its own centre and margin', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  record(midi.access, { endless: (cc) => cc === 3, centre: 50, margin: 4 })
  const [k3, k4] = [mpd.knob(3, 0, 100), mpd.knob(4, 0, 100)]
  for (let i = 0; i < 23; i++) { // up to 123, within 4 of the end
    k3.turn(1, 1000 + i * 20)
    k4.turn(1, 1000 + i * 20)
  }
  assert.deepEqual(mpd.received, [[0xb0, 3, 50]])
})

test('resets go to the output port with the input\'s name and manufacturer', () => {
  const midi = fakeMidi()
  const decoy = midi.addOutput('MPD218 Port A', 'Someone else')
  const mpd = midi.plug()
  const loner = midi.plug({ name: 'Loner', output: false })
  assert.equal(outputFor(midi.access, mpd.input), mpd.output)
  assert.equal(outputFor(midi.access, loner.input), undefined)

  record(midi.access, { endless: true })
  const k = mpd.knob(3, 2, 100)
  for (let i = 0; i < 12; i++) k.turn(1, 1000 + i * 20)
  assert.deepEqual(mpd.received, [[0xb2, 3, 64]])
  assert.deepEqual(decoy.received, [])
})

test('listen decodes relative knobs and never resets them', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const { turns } = record(midi.access, { encoding: 'twos-complement', endless: true })
  mpd.send([0xb0, 3, 1], 1000)
  mpd.send([0xb0, 3, 127], 1250)
  mpd.send([0xb0, 3, 120], 1500)
  mpd.send([0xb0, 3, 3], 1510)
  assert.deepEqual(deltas(turns), [1, -1, -8, 3])
  close(turns[0]!.step, 0.25) // a relative knob has nothing to anchor, so its first message moves
  assert.ok(turns[3]!.speed > 0)
  assert.deepEqual(mpd.received, [])
})

test('the encoding can be chosen per CC', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const { turns } = record(midi.access, { encoding: (cc) => (cc === 10 ? 'binary-offset' : 'absolute') })
  mpd.send([0xb0, 10, 65], 1000)
  mpd.send([0xb0, 3, 65], 1000)
  mpd.send([0xb0, 10, 62], 1300)
  mpd.send([0xb0, 3, 62], 1300)
  assert.deepEqual(turns.map((turn) => [turn.cc, turn.delta]), [[10, 1], [3, 0], [10, -2], [3, -3]])
})

test('dispose stops listening, without disturbing other listeners', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const first = record(midi.access)
  const second = record(midi.access)
  const k = mpd.knob(3)
  k.turn(1, 1000)
  first.dispose()
  k.turn(1, 1300)
  midi.plug({ id: 'later' }).knob(3).turn(1, 1600)
  assert.equal(first.turns.length, 1)
  assert.equal(second.turns.length, 3)
})

test('knob owns a value and calls back when a turn changes it', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const changes: Array<[number, number]> = []
  const gain = knob(midi.access, {
    cc: 3, value: 0.5, min: 0, max: 1, fine: 0.001, coarse: 0.05,
    onChange: (value, turn) => changes.push([value, turn.delta]),
  })
  const k = mpd.knob(3)
  k.turn(1, 1000) // anchors
  k.turn(1, 1250)
  k.turn(-2, 1500)
  assert.equal(changes.length, 2)
  close(changes[0]![0], 0.501, 1e-4)
  assert.equal(changes[1]![1], -2)
  close(gain.value, 0.499, 1e-4)
})

test('knob stays within its range', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const changes: number[] = []
  const level = knob(midi.access, { cc: 3, value: 0.99, min: 0, max: 1, fine: 0.01, coarse: 0.1, onChange: (value) => changes.push(value) })
  const k = mpd.knob(3)
  for (let i = 0; i < 10; i++) k.turn(5, 1000 + i * 10)
  assert.equal(level.value, 1)
  assert.equal(changes.at(-1), 1)
  assert.equal(changes.filter((value) => value === 1).length, 1, 'no callback once nothing changes')
})

test('knob turns forever when the controller takes resets', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const counter = knob(midi.access, { cc: 3, value: 0, min: 0, max: 10_000, fine: 1, coarse: 1 })
  const k = mpd.knob(3)
  for (let i = 0; i < 300; i++) k.turn(1, 1000 + i * 20)
  assert.equal(counter.value, 299)
  assert.ok(mpd.received.length > 0)
})

test('knob can be told not to reset', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const counter = knob(midi.access, { cc: 3, value: 0, min: 0, max: 10_000, fine: 1, coarse: 1, endless: false })
  const k = mpd.knob(3)
  for (let i = 0; i < 300; i++) k.turn(1, 1000 + i * 20)
  assert.equal(counter.value, 62) // anchored at 65, then 62 values to 127
  assert.deepEqual(mpd.received, [])
})

test('knob steps in cents on an exponential scale', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const frequency = knob(midi.access, { cc: 3, value: 440, min: 20, max: 20_000, scale: 'exponential', fine: 100, coarse: 100 })
  const k = mpd.knob(3)
  for (let i = 0; i < 13; i++) k.turn(1, 1000 + i * 250)
  close(frequency.value, 880, 1e-6) // 12 semitones
})

test('knob goes round on a wrapping scale', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const angle = knob(midi.access, { cc: 3, value: 350, min: 0, max: 360, scale: 'wrap', fine: 5, coarse: 5 })
  const k = mpd.knob(3)
  for (let i = 0; i < 5; i++) k.turn(1, 1000 + i * 250)
  assert.equal(angle.value, 10)
})

test('knob takes a scale of your own', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const steps10 = knob(midi.access, {
    cc: 3, value: 0, min: 0, max: 100, fine: 1, coarse: 1,
    scale: (value, step, min, max) => Math.min(max, Math.max(min, value + step * 10)),
  })
  const k = mpd.knob(3)
  k.turn(1, 1000)
  k.turn(1, 1250)
  assert.equal(steps10.value, 10)
})

test('knob.set moves the value without calling back, and turns carry on from it', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const changes: number[] = []
  const level = knob(midi.access, { cc: 3, value: 0, min: 0, max: 100, fine: 1, coarse: 1, onChange: (value) => changes.push(value) })
  level.set(40)
  assert.equal(level.value, 40)
  level.set(-5)
  assert.equal(level.value, 0)
  level.set(40)
  const k = mpd.knob(3)
  k.turn(1, 1000)
  k.turn(1, 1250)
  assert.deepEqual(changes, [41])
})

test('knob listens to its own CC and channel only', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const level = knob(midi.access, { cc: 3, channel: 1, value: 0, min: 0, max: 100, fine: 1, coarse: 1 })
  for (const k of [mpd.knob(3, 0), mpd.knob(4, 1), mpd.knob(3, 1)]) {
    k.turn(1, 1000)
    k.turn(1, 1250)
  }
  assert.equal(level.value, 1)
})

test('knob takes relative encodings', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const level = knob(midi.access, { cc: 3, value: 0, min: 0, max: 100, fine: 1, coarse: 1, encoding: 'sign-magnitude' })
  mpd.send([0xb0, 3, 3], 1000)
  mpd.send([0xb0, 3, 65], 1250)
  assert.equal(level.value, 2)
  assert.deepEqual(mpd.received, [])
})

test('knob.dispose stops it', () => {
  const midi = fakeMidi()
  const mpd = midi.plug()
  const level = knob(midi.access, { cc: 3, value: 0, min: 0, max: 100, fine: 1, coarse: 1 })
  const k = mpd.knob(3)
  k.turn(1, 1000)
  k.turn(1, 1250)
  level.dispose()
  k.turn(1, 1500)
  assert.equal(level.value, 1)
})

test('knob refuses a range it cannot work in', () => {
  const access = fakeMidi().access
  const base = { cc: 3, value: 1, fine: 1, coarse: 1 }
  assert.throws(() => knob(access, { ...base, min: 1, max: 1 }), RangeError)
  assert.throws(() => knob(access, { ...base, min: 0, max: 10, scale: 'exponential' }), RangeError)
})

test('requestMidiAccess explains when Web MIDI is not available', async () => {
  await assert.rejects(requestMidiAccess(), /Web MIDI is not available/)
})

test('requestMidiAccess asks the browser for access', async () => {
  const access = fakeMidi().access
  const asked: unknown[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { requestMIDIAccess: (options: unknown) => (asked.push(options), Promise.resolve(access)) },
  })
  try {
    assert.equal(await requestMidiAccess(), access)
    assert.deepEqual(asked, [{ sysex: false }])
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
  }
})
