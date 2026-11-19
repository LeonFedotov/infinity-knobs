import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exponential, linear, wrap } from '../src/scale.ts'

const close = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

test('exponential moves by cents and stays within its range', () => {
  close(exponential(440, 1200, 0.01, 5000), 880)
  close(exponential(440, -1200, 0.01, 5000), 220)
  close(exponential(440, 100, 0.01, 5000), 440 * 2 ** (1 / 12))
  assert.equal(exponential(4000, 1200, 0.01, 5000), 5000)
  assert.equal(exponential(0.02, -2400, 0.01, 5000), 0.01)
  assert.equal(exponential(0, 100, 0.01, 1000), 0.01) // a value at 0 can still be turned up
})

test('exponential takes its own steps per doubling', () => {
  assert.equal(exponential(1, 1, 0.1, 10, 1), 2)
  close(exponential(1, -6, 0.1, 10, 12), Math.SQRT1_2)
})

test('linear adds the step and stays within its range', () => {
  assert.equal(linear(0.5, 0.25, 0, 1), 0.75)
  assert.equal(linear(0.5, -0.25, 0, 1), 0.25)
  assert.equal(linear(0.9, 0.25, 0, 1), 1)
  assert.equal(linear(0.1, -0.25, 0, 1), 0)
})

test('wrap goes round from one end of its range to the other', () => {
  assert.equal(wrap(350, 20, 0, 360), 10)
  assert.equal(wrap(10, -30, 0, 360), 340)
  assert.equal(wrap(10, 725, 0, 360), 15)
  assert.equal(wrap(10, -725, 0, 360), 5)
  assert.equal(wrap(350, 10, 0, 360), 0) // the top of the range is the bottom
  assert.equal(wrap(-170, -20, -180, 180), 170)
  close(wrap(Math.PI, 1.5 * Math.PI, 0, 2 * Math.PI), Math.PI / 2)
})
