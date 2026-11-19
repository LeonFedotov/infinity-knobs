// Decoders for relative Control Change encodings, where each message is a move rather than a position

/**
 * How a relative knob writes a move into a 7-bit value:
 * - `twos-complement`: 1 to 63 up, 127 down to 65 down (127 is -1).
 * - `binary-offset`: 64 plus the move (65 is +1, 63 is -1).
 * - `sign-magnitude`: bit 6 is the sign, the low 6 bits the size (1 is +1, 65 is -1).
 */
export type RelativeEncoding = 'twos-complement' | 'binary-offset' | 'sign-magnitude'

/** How a knob sends its Control Change: `absolute` is a position from 0 to 127. */
export type Encoding = 'absolute' | RelativeEncoding

/** The signed move in a relative knob's Control Change value (0–127). */
export function decodeRelative(value: number, encoding: RelativeEncoding): number {
  switch (encoding) {
    case 'twos-complement':
      return value < 64 ? value : value - 128
    case 'binary-offset':
      return value - 64
    case 'sign-magnitude': {
      const size = value & 0x3f
      return (value & 0x40) !== 0 && size > 0 ? -size : size
    }
  }
}
