// A fake Web MIDI setup for tests, with controllers that behave like an Akai MPD218 in CC mode:
// knobs send absolute 0–127, go silent at either end while you keep turning, and carry on from a
// value the host sends back on the same CC and channel. That feedback arrives one message late,
// as on USB: the message already on its way was measured from the old position.

export interface FakeKnob {
  /** Where the controller thinks the knob is. */
  readonly position: () => number
  /** Turns the knob by `by` values in one message at `time` (ms). Silent at either end. */
  readonly turn: (by: number, time: number) => void
}

export interface DeviceOptions {
  readonly id?: string
  readonly name?: string
  readonly manufacturer?: string
  /** Whether the device has an output port. Default true. */
  readonly output?: boolean
  /** Whether its knobs take the value they are sent. Default true. */
  readonly takesFeedback?: boolean
  /** How many of the knob's own messages are already on their way when feedback arrives. Default 1. */
  readonly lag?: number
}

export interface FakeDevice {
  readonly input: MIDIInput
  readonly output: MIDIOutput | undefined
  /** Every message the host sent to the device. */
  readonly received: number[][]
  /** An MPD218-style knob on `cc` and `channel`, starting at `position`. */
  readonly knob: (cc: number, channel?: number, position?: number) => FakeKnob
  /** Sends any message from the device at `time` (ms). */
  readonly send: (data: readonly number[], time: number) => void
}

export interface FakeMidi {
  readonly access: MIDIAccess
  /** Connects a device, as if plugged in, and announces it with a statechange event. */
  readonly plug: (options?: DeviceOptions) => FakeDevice
  /** Adds an output port on its own, such as another device's. */
  readonly addOutput: (name: string, manufacturer: string) => FakeOutputLog
}

export interface FakeOutputLog {
  readonly output: MIDIOutput
  /** Every message the host sent to this port. */
  readonly received: number[][]
}

const port = <T>(fields: Record<string, unknown>): T => Object.assign(new EventTarget(), fields) as unknown as T

const midiMessage = (data: readonly number[], time: number): Event => {
  const event = Object.assign(new Event('midimessage'), { data: Uint8Array.from(data) })
  Object.defineProperty(event, 'timeStamp', { value: time })
  return event
}

export function fakeMidi(): FakeMidi {
  const inputs = new Map<string, MIDIInput>()
  const outputs = new Map<string, MIDIOutput>()
  const access = Object.assign(new EventTarget(), { inputs, outputs, sysexEnabled: false }) as unknown as MIDIAccess
  let devices = 0

  const addOutput = (name: string, manufacturer: string, onSend: (data: number[]) => void = () => {}): FakeOutputLog => {
    const received: number[][] = []
    const id = `output-${outputs.size + 1}`
    const output = port<MIDIOutput>({
      id, name, manufacturer, type: 'output', state: 'connected', connection: 'open',
      send: (data: Iterable<number>) => {
        const message = [...data]
        received.push(message)
        onSend(message)
      },
    })
    outputs.set(id, output)
    return { output, received }
  }

  const plug = (options: DeviceOptions = {}): FakeDevice => {
    devices += 1
    const { id = `input-${devices}`, name = 'MPD218 Port A', manufacturer = 'Akai', takesFeedback = true, lag = 1 } = options
    const knobs = new Map<string, (value: number) => void>()
    const input = port<MIDIInput>({ id, name, manufacturer, type: 'input', state: 'connected', connection: 'open' })
    const send = (data: readonly number[], time: number): void => {
      input.dispatchEvent(midiMessage(data, time))
    }

    const onFeedback = (data: number[]): void => {
      const [status = 0, cc, value = 0] = data
      if (takesFeedback && (status & 0xf0) === 0xb0) knobs.get(`${status & 0x0f}/${cc}`)?.(value)
    }
    const log = options.output === false ? undefined : addOutput(name, manufacturer, onFeedback)

    const knob = (cc: number, channel = 0, start = 64): FakeKnob => {
      let position = start
      let pending: Array<{ value: number, after: number }> = []
      knobs.set(`${channel}/${cc}`, (value) => {
        pending = [...pending, { value, after: lag }]
      })
      const turn = (by: number, time: number): void => {
        // Feedback that has arrived replaces the position before this message is measured
        const arrived = pending.filter((feedback) => feedback.after === 0).at(-1)
        if (arrived) position = arrived.value
        pending = pending.filter((feedback) => feedback.after > 0).map((feedback) => ({ ...feedback, after: feedback.after - 1 }))
        const next = Math.min(127, Math.max(0, position + by))
        if (next === position) return // silent at either end
        position = next
        send([0xb0 | channel, cc, position], time)
      }
      return { position: () => position, turn }
    }

    inputs.set(id, input)
    access.dispatchEvent(new Event('statechange'))
    return { input, output: log?.output, received: log?.received ?? [], knob, send }
  }

  return { access, plug, addOutput: (name, manufacturer) => addOutput(name, manufacturer) }
}
