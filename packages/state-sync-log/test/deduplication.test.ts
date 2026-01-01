import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"

describe("Deduplication Edge Cases", () => {
  describe("Checkpoint-based pruning", () => {
    it("txs are pruned after compact", () => {
      const docA = new Y.Doc()
      const logA = createStateSyncLog<any>({
        yDoc: docA,
        clientId: "A",
        retentionWindowMs: undefined,
      })

      // A creates a tx
      logA.emit([{ kind: "set", path: [], key: "counter", value: 1 }])

      // A compacts - this creates a checkpoint including the tx
      logA.compact()

      // The tx should be pruned after compact
      const txs = logA[getSortedTxsSymbol]()
      expect(txs.length).toBe(0)

      // The state should still have the value from the checkpoint
      expect(logA.getState().counter).toBe(1)
    })

    it("txs in a received checkpoint are not duplicated", () => {
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

      // A creates T1 and compacts
      logA.emit([{ kind: "set", path: [], key: "val", value: 1 }])
      logA.compact()

      // Sync A to B (B receives checkpoint)
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

      // B should have the correct state
      expect(logB.getState().val).toBe(1)

      // B should not have any pending txs
      expect(logB[getSortedTxsSymbol]().length).toBe(0)
    })
  })

  describe("Re-emit deduplication", () => {
    it("re-emitted txs are not applied twice", () => {
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

      // Both start with same base
      logA.emit([{ kind: "set", path: [], key: "arr", value: [] }])
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

      // A emits a splice (adds element to array)
      logA.emit([{ kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [1] }])

      // B compacts (misses T1)
      logB.compact()

      // Sync A to B - B receives T1, re-emits it
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      expect(logB.getState().arr).toStrictEqual([1])

      // Sync B back to A - A receives the re-emit
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))

      // A should still have [1], NOT [1, 1]
      expect(logA.getState().arr).toStrictEqual([1])
    })

    it("original and re-emit arriving at third client are deduplicated", () => {
      const docA = new Y.Doc()
      const docB = new Y.Doc()
      const docC = new Y.Doc()

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
      const logC = createStateSyncLog<any>({
        yDoc: docC,
        clientId: "C",
        retentionWindowMs: undefined,
      })

      // All start with same base
      logA.emit([{ kind: "set", path: [], key: "arr", value: [] }])
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      Y.applyUpdate(docC, Y.encodeStateAsUpdate(docA))

      // A emits T1 (push 1)
      logA.emit([{ kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [1] }])

      // B compacts (doesn't have T1)
      logB.compact()

      // B receives T1 from A, re-emits as T1'
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

      // C receives BOTH T1 from A and T1' from B
      Y.applyUpdate(docC, Y.encodeStateAsUpdate(docA))
      Y.applyUpdate(docC, Y.encodeStateAsUpdate(docB))

      // C should have [1], NOT [1, 1]
      expect(logC.getState().arr).toStrictEqual([1])
    })
  })
})
