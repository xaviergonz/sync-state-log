import { describe, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Performance", () => {
  // Use 1000 for fast CI. Increase to 10000+ for stress testing.
  const iterations = 10000

  it(`measures performance of ${iterations} 10 array pushes`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Initialize array
    log.emit([{ kind: "set", path: [], key: "list", value: [] }])

    let listIndex = 0
    for (let i = 0; i < iterations; i++) {
      const ops = []
      for (let j = 0; j < 10; j++) {
        ops.push({
          kind: "splice" as const,
          path: ["list"],
          index: listIndex,
          deleteCount: 0,
          inserts: [i + j],
        })
        listIndex++
      }
      log.emit(ops)
    }
  }, 60000) // 60s timeout

  it(`measures performance of ${iterations} 10 random updates on an object with 1000 keys`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Initialize with 1000 keys
    const initOps = []
    for (let i = 0; i < 1000; i++) {
      initOps.push({ kind: "set" as const, path: [], key: `key_${i}`, value: i })
    }
    log.emit(initOps)

    for (let i = 0; i < iterations; i++) {
      const ops = []
      for (let j = 0; j < 10; j++) {
        const keyIndex = Math.floor(Math.random() * 1000)
        ops.push({ kind: "set" as const, path: [], key: `key_${keyIndex}`, value: i * 10 + j })
      }
      log.emit(ops)
    }
  }, 60000)
})
