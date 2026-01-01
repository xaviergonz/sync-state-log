import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Performance", () => {
  // Use 1000 for fast CI. Increase to 10000+ for stress testing.
  const iterations = 10000

  it(`measures performance of ${iterations} array pushes`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Initialize array
    log.emit([{ kind: "set", path: [], key: "list", value: [] }])

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      log.emit([{ kind: "splice", path: ["list"], index: i, deleteCount: 0, inserts: [i] }])
    }
    const end = performance.now()

    console.log(`${iterations} Array Pushes: ${(end - start).toFixed(2)}ms`)
    console.log(`Average per push: ${((end - start) / iterations).toFixed(3)}ms`)

    expect(log.getState().list.length).toBe(iterations)
  }, 30000) // 30s timeout

  it(`measures performance of ${iterations} random updates on an object with 1000 keys`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Initialize with 1000 keys
    for (let i = 0; i < 1000; i++) {
      log.emit([{ kind: "set", path: [], key: `key_${i}`, value: i }])
    }

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      const keyIndex = Math.floor(Math.random() * 1000)
      log.emit([{ kind: "set", path: [], key: `key_${keyIndex}`, value: i }])
    }
    const end = performance.now()

    console.log(`${iterations} Random Updates: ${(end - start).toFixed(2)}ms`)
    console.log(`Average per update: ${((end - start) / iterations).toFixed(3)}ms`)

    expect(Object.keys(log.getState()).length).toBe(1000)
  }, 30000)
})
