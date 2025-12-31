import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Sync", () => {
  it("syncs between two clients", async () => {
    const doc = new Y.Doc()
    const log1 = createStateSyncLog<any>({ yDoc: doc, clientId: "A", retentionWindowMs: undefined })
    const log2 = createStateSyncLog<any>({ yDoc: doc, clientId: "B", retentionWindowMs: undefined })

    log1.emit([{ kind: "set", path: [], key: "msg", value: "hello" }])

    expect(log1.getState()).toStrictEqual({ msg: "hello" })
    expect(log2.getState()).toStrictEqual({ msg: "hello" })
  })

  it("handles out-of-order transactions", () => {
    const doc = new Y.Doc()
    const log1 = createStateSyncLog<any>({ yDoc: doc, clientId: "A", retentionWindowMs: undefined })
    const log2 = createStateSyncLog<any>({ yDoc: doc, clientId: "B", retentionWindowMs: undefined })

    log1.emit([{ kind: "set", path: [], key: "x", value: 1 }]) // Clock 1
    log2.emit([{ kind: "set", path: [], key: "x", value: 2 }]) // Clock 2 (sees Clock 1)

    // Final state should be x=2 because Clock 2 > Clock 1
    expect(log1.getState().x).toBe(2)
    expect(log2.getState().x).toBe(2)
  })

  it("maintains Lamport clock monotonicity with rapid emissions", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    for (let i = 0; i < 10; i++) {
      log.emit([{ kind: "set", path: [], key: `key${i}`, value: i }])
    }

    const state = log.getState()
    for (let i = 0; i < 10; i++) {
      expect(state[`key${i}`]).toBe(i)
    }
  })

  it("checkpoint state is preserved and loaded by new client", () => {
    const doc = new Y.Doc()
    const log1 = createStateSyncLog<any>({ yDoc: doc, clientId: "A", retentionWindowMs: undefined })

    log1.emit([{ kind: "set", path: [], key: "data", value: { preserved: true } }])
    log1.compact()

    const log2 = createStateSyncLog<any>({ yDoc: doc, clientId: "B", retentionWindowMs: undefined })

    expect(log2.getState()).toStrictEqual({ data: { preserved: true } })
  })

  it("both clients see same state after concurrent edits", () => {
    const doc = new Y.Doc()
    const log1 = createStateSyncLog<any>({ yDoc: doc, clientId: "A", retentionWindowMs: undefined })
    const log2 = createStateSyncLog<any>({ yDoc: doc, clientId: "B", retentionWindowMs: undefined })

    log1.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    log2.emit([{ kind: "set", path: [], key: "b", value: 2 }])

    expect(log1.getState()).toStrictEqual({ a: 1, b: 2 })
    expect(log2.getState()).toStrictEqual({ a: 1, b: 2 })
  })

  it("re-emits missed transactions in order after checkpoint sync", () => {
    // Setup: Two isolated Y.Doc instances (simulating network separation)
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const logA = createStateSyncLog<any>({
      yDoc: docA,
      clientId: "A",
      retentionWindowMs: undefined,
    })

    const logB = createStateSyncLog<any>({
      yDoc: docB,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    // Step 1: Client A creates multiple ordered transactions while offline
    // These use an array to track the expected final order
    logA.emit([{ kind: "set", path: [], key: "step1", value: "first" }])
    logA.emit([{ kind: "set", path: [], key: "step2", value: "second" }])
    logA.emit([{ kind: "set", path: [], key: "step3", value: "third" }])
    logA.emit([{ kind: "set", path: [], key: "order", value: [1] }])
    logA.emit([{ kind: "set", path: [], key: "order", value: [1, 2] }])
    logA.emit([{ kind: "set", path: [], key: "order", value: [1, 2, 3] }])

    // Step 2: Client B creates its own transaction AND compacts
    // This creates a checkpoint that does NOT include A's transactions
    logB.emit([{ kind: "set", path: [], key: "fromB", value: "B was here" }])
    logB.compact()

    // Verify B has compacted (epoch 1, A's transactions not in checkpoint)
    expect(logB.getActiveEpoch()).toBe(1)

    // Step 3: Sync B's state (with checkpoint) to A
    // A will receive the checkpoint and must re-emit its missed transactions
    const stateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docA, stateB)

    // Step 4: Verify A's state includes both:
    // - B's checkpoint content
    // - A's re-emitted transactions (applied in correct order)
    const stateA = logA.getState()
    expect(stateA.fromB).toBe("B was here") // From B's checkpoint
    expect(stateA.step1).toBe("first") // A's re-emitted
    expect(stateA.step2).toBe("second") // A's re-emitted
    expect(stateA.step3).toBe("third") // A's re-emitted
    // The order array should have final value [1, 2, 3] from ordered application
    expect(stateA.order).toStrictEqual([1, 2, 3])

    // Step 5: Now sync A back to B to complete convergence
    const stateA2 = Y.encodeStateAsUpdate(docA)
    Y.applyUpdate(docB, stateA2)

    // Both should have identical state
    expect(logA.getState()).toStrictEqual(logB.getState())
    expect(logB.getState().order).toStrictEqual([1, 2, 3])
  })
})
