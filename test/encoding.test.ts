import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeRelative, type RelativeEncoding } from '../src/encoding.ts'

const decodeAll = (encoding: RelativeEncoding, values: readonly number[]): number[] =>
  values.map((value) => decodeRelative(value, encoding))

test('two\'s complement: 1 to 63 turn up, 127 down to 65 turn down', () => {
  assert.deepEqual(decodeAll('twos-complement', [0, 1, 2, 63, 64, 65, 126, 127]), [0, 1, 2, 63, -64, -63, -2, -1])
})

test('binary offset: 64 plus or minus the step', () => {
  assert.deepEqual(decodeAll('binary-offset', [0, 1, 62, 63, 64, 65, 66, 127]), [-64, -63, -2, -1, 0, 1, 2, 63])
})

test('sign-magnitude: bit 6 is the sign, the low 6 bits the size', () => {
  assert.deepEqual(decodeAll('sign-magnitude', [0, 1, 2, 63, 64, 65, 66, 127]), [0, 1, 2, 63, 0, -1, -2, -63])
})
