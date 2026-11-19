import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CENTRE, defaults, recentre, shouldRecentre, turnBy, turnTo, type KnobState, type Motion, type Turn } from '../src/turn.ts'

const steps = { fine: 0.25, coarse: 50 }

const close = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

type Message = readonly [value: number, time: number]

// Plays an absolute knob through `messages`, returning the turn of each one
const play = (messages: readonly Message[], options = steps): Turn[] => {
  let state: KnobState | undefined
  return messages.map(([value, time]) => {
    const turn = turnTo(state, value, time, options)
    state = turn.state
    return turn
  })
}

const stepsOf = (messages: readonly Message[]): number[] => play(messages).map((turn) => turn.step)

const at = (value: number): KnobState => turnTo(undefined, value, 0, steps).state

test('turnTo only remembers a knob on its first message, so touching it never jumps', () => {
  const turn = turnTo(undefined, 90, 1000, steps)
  assert.deepEqual(turn, { state: { value: 90, time: 1000, rate: 0 }, delta: 0, step: 0, speed: 0, rate: 0 })
})

test('turnTo moves in fine steps when the knob turns slowly', () => {
  const [, up, down] = stepsOf([[60, 0], [61, 250], [60, 500]])
  close(up!, 0.25, 0.01)
  close(down!, -0.25, 0.01)
})

test('turnTo speeds up to coarse steps when the knob turns fast', () => {
  // An MPD218 spun hard sends a message every 10 ms, up to 7 values apart (700 values a second)
  const turned = stepsOf([[10, 0], [17, 10], [24, 20], [31, 30], [38, 40]])
  close(turned.at(-1)!, 7 * 50, 0.01)
  assert.ok(turned.every((step, i) => i < 2 || step >= turned[i - 1]!), 'never slows down while speeding up')
})

test('turnTo keeps a deliberate turn of a smooth knob under a unit per value', () => {
  // Measured on an MPD218, whose knobs have no clicks: a careful turn runs at about 60 values a second
  const messages = Array.from({ length: 20 }, (_, i): Message => [10 + i, Math.round((i * 1000) / 60)])
  const turned = stepsOf(messages)
  assert.ok(turned.slice(1).every((step) => step > 0.25 && step < 1), turned.join(', '))
})

test('turnTo gets faster gradually in between', () => {
  const medium = stepsOf([[10, 0], [11, 33], [12, 66], [13, 100]]).at(-1)! // about 30 values a second
  assert.ok(medium > 0.25 && medium < 50, `${medium}`)
})

test('turnTo forgets its speed after a pause', () => {
  const turned = stepsOf([[10, 0], [13, 10], [16, 20], [19, 30], [20, 1030]])
  close(turned.at(-1)!, 0.25, 0.01)
})

test('turnTo ignores a repeated value', () => {
  assert.deepEqual(stepsOf([[127, 0], [127, 10]]), [0, 0])
})

test('turnTo returns new state without changing the old one', () => {
  const first = turnTo(undefined, 5, 0, steps).state
  const frozen = { ...first }
  turnTo(first, 9, 10, steps)
  assert.deepEqual(first, frozen)
})

test('turnTo reports the raw delta, the rate in values a second and the speed from 0 to 1', () => {
  const [, turn] = play([[10, 0], [17, 10]])
  // 7 values in 10 ms is 700 values a second, averaged with the 0 it started from
  assert.equal(turn!.delta, 7)
  close(turn!.rate, 350)
  close(turn!.speed, (350 / 400) ** 3)
  close(turn!.step, 7 * (0.25 + (50 - 0.25) * (350 / 400) ** 3))
  assert.equal(turn!.state.rate, turn!.rate)
})

test('turnTo caps the speed at 1 at the fast rate and above', () => {
  const turns = play([[0, 0], [7, 10], [14, 20], [21, 30], [28, 40]])
  assert.equal(turns.at(-1)!.speed, 1)
  assert.ok(turns.every((turn) => turn.speed >= 0 && turn.speed <= 1))
})

test('turnTo takes its own fast rate and pause', () => {
  const options = { ...steps, fastRate: 100, pauseMs: 2000 }
  const turns = play([[10, 0], [11, 10]], options) // 100 values a second, averaged with 0: 50
  close(turns[1]!.speed, (50 / 100) ** 3)
  const afterWait = turnTo(turns[1]!.state, 12, 1010, options) // 1 s is not a pause any more
  close(afterWait.rate, (50 + 1) / 2)
})

test('the defaults are the ones calibrated on an MPD218', () => {
  assert.deepEqual(defaults, { fastRate: 400, pauseMs: 250, centre: 64, margin: 16 })
  assert.ok(Object.isFrozen(defaults))
})

test('turnBy steps a relative knob by the delta it sends', () => {
  let state: Motion | undefined
  const turns = [[1, 0], [1, 250], [-1, 500]].map(([delta, time]) => {
    const turn = turnBy(state, delta!, time!, steps)
    state = turn.state
    return turn
  })
  // A relative knob has no position to anchor, so even its first message moves it, at rest
  assert.deepEqual(turns[0], { state: { time: 0, rate: 0 }, delta: 1, step: 0.25, speed: 0, rate: 0 })
  close(turns[1]!.step, 0.25, 0.01)
  close(turns[2]!.step, -0.25, 0.01)
})

test('turnBy speeds up like turnTo', () => {
  let state: Motion | undefined
  const turns = [0, 10, 20, 30, 40].map((time) => {
    const turn = turnBy(state, 7, time, steps)
    state = turn.state
    return turn
  })
  close(turns.at(-1)!.step, 7 * 50, 0.01)
})

test('shouldRecentre sends a knob back to the middle as it nears either end', () => {
  assert.equal(shouldRecentre(at(CENTRE)), false)
  assert.equal(shouldRecentre(at(100)), false)
  assert.equal(shouldRecentre(at(110)), false)
  assert.equal(shouldRecentre(at(111)), true)
  assert.equal(shouldRecentre(at(112)), true)
  assert.equal(shouldRecentre(at(127)), true)
  assert.equal(shouldRecentre(at(17)), false)
  assert.equal(shouldRecentre(at(16)), true)
  assert.equal(shouldRecentre(at(15)), true)
  assert.equal(shouldRecentre(at(0)), true)
})

test('shouldRecentre takes its own margin', () => {
  assert.equal(shouldRecentre(at(120), { margin: 4 }), false)
  assert.equal(shouldRecentre(at(123), { margin: 4 }), true)
  assert.equal(shouldRecentre(at(4), { margin: 4 }), true)
})

test('shouldRecentre waits until a reset has arrived before sending another', () => {
  const state = recentre(at(127))
  assert.equal(shouldRecentre({ ...state, value: 120 }), false)
})

test('recentre moves the knob to the middle and remembers where it was', () => {
  const state = at(127)
  const frozen = { ...state }
  assert.deepEqual(recentre(state), { ...state, value: CENTRE, recentredFrom: 127 })
  assert.deepEqual(recentre(state, { centre: 50 }), { ...state, value: 50, recentredFrom: 127 })
  assert.deepEqual(state, frozen)
})

// Plays `values` into a knob that was just sent back to the centre from `from`, returning each
// message's direction, its delta, and whether the knob is still waiting for the reset to arrive
const afterRecentre = (from: number, values: readonly number[]): Array<[number, number, boolean]> => {
  let state = recentre(turnTo(at(from - 1), from, 250, steps).state)
  return values.map((value, i) => {
    const turn = turnTo(state, value, 500 + i * 250, steps)
    state = turn.state
    return [Math.sign(turn.step), turn.delta, state.recentredFrom !== undefined]
  })
}

test('turnTo continues from the middle once the knob has been reset', () => {
  // up past the end: 127, reset to 64, then the knob carries on at 65, 66
  assert.deepEqual(afterRecentre(127, [65, 66]), [[1, 1, false], [1, 1, false]])
  // or turns back: 63
  assert.deepEqual(afterRecentre(127, [63]), [[-1, -1, false]])
})

test('turnTo reads a message sent before the reset arrived from the old position', () => {
  // reset at 120 while still turning: 122 and 125 were already on their way, then 66 from the middle
  assert.deepEqual(afterRecentre(120, [122, 125, 66]), [[1, 2, true], [1, 3, true], [1, 2, false]])
})

test('turnTo keeps working with a controller that ignores the reset', () => {
  assert.deepEqual(afterRecentre(120, [121, 122, 121]), [[1, 1, true], [1, 1, true], [-1, -1, true]])
})

test('turnTo continues from a custom centre', () => {
  const state = recentre(at(120), { centre: 50 })
  assert.equal(turnTo(state, 51, 10, steps).delta, 1)
})
