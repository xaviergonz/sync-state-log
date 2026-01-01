import { beforeEach, describe, expect, it } from "vitest"
import * as Y from "yjs"
import { CheckpointRecord } from "../src/checkpoints"
import { JSONObject, JSONValue } from "../src/json"
import { Op } from "../src/operations"
import { StateCalculator } from "../src/StateCalculator"
import { TxRecord } from "../src/TxRecord"
import { TxTimestamp, txTimestampToKey } from "../src/txTimestamp"

// Helper to create a timestamp key
function createTxKey(
  epoch: number,
  clock: number,
  clientId: string,
  wallClock = Date.now()
): string {
  const ts: TxTimestamp = { epoch, clock, clientId, wallClock }
  return txTimestampToKey(ts)
}

// Helper to create a simple set op (sets key on root object)
function setOp(key: string, value: JSONValue): Op {
  return { kind: "set", path: [], key, value }
}

describe("StateCalculator", () => {
  let doc: Y.Doc
  let yTx: Y.Map<TxRecord>
  let calc: StateCalculator

  beforeEach(() => {
    doc = new Y.Doc()
    yTx = doc.getMap("tx") as Y.Map<TxRecord>
    calc = new StateCalculator()
  })

  describe("insertTx", () => {
    it("inserts transactions in sorted order", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")
      const key3 = createTxKey(1, 3, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })
      yTx.set(key3, { ops: [setOp("c", 3)] })

      calc.insertTx(key2, yTx)
      calc.insertTx(key1, yTx)
      calc.insertTx(key3, yTx)

      const sorted = calc.getSortedTxs()
      expect(sorted.length).toBe(3)
      expect(sorted[0].txTimestampKey).toBe(key1)
      expect(sorted[1].txTimestampKey).toBe(key2)
      expect(sorted[2].txTimestampKey).toBe(key3)
    })

    it("returns false for duplicate inserts", () => {
      const key = createTxKey(1, 1, "client1")
      yTx.set(key, { ops: [setOp("a", 1)] })

      expect(calc.insertTx(key, yTx)).toBe(false)
      expect(calc.insertTx(key, yTx)).toBe(false)
      expect(calc.txCount).toBe(1)
    })

    it("returns true when inserting before calculated slice", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")
      const key3 = createTxKey(1, 3, "client1")

      yTx.set(key2, { ops: [setOp("b", 2)] })
      yTx.set(key3, { ops: [setOp("c", 3)] })
      yTx.set(key1, { ops: [setOp("a", 1)] })

      calc.insertTx(key2, yTx)
      calc.insertTx(key3, yTx)

      // Calculate state - this sets lastAppliedIndex
      calc.calculateState()
      expect(calc.needsFullRecalculation()).toBe(false)

      // Insert before the calculated slice
      const invalidated = calc.insertTx(key1, yTx)
      expect(invalidated).toBe(true)
      expect(calc.needsFullRecalculation()).toBe(true)
    })

    it("returns false when inserting after calculated slice", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })

      calc.insertTx(key1, yTx)
      calc.calculateState()
      expect(calc.needsFullRecalculation()).toBe(false)

      // Insert after the calculated slice
      const invalidated = calc.insertTx(key2, yTx)
      expect(invalidated).toBe(false)
      expect(calc.needsFullRecalculation()).toBe(false)
    })

    it("tracks maxSeenClock", () => {
      const key1 = createTxKey(1, 5, "client1")
      const key2 = createTxKey(1, 10, "client2")
      const key3 = createTxKey(1, 3, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })
      yTx.set(key3, { ops: [setOp("c", 3)] })

      calc.insertTx(key1, yTx)
      expect(calc.getMaxSeenClock()).toBe(5)

      calc.insertTx(key2, yTx)
      expect(calc.getMaxSeenClock()).toBe(10)

      // Inserting a lower clock shouldn't change max
      calc.insertTx(key3, yTx)
      expect(calc.getMaxSeenClock()).toBe(10)
    })
  })

  describe("removeTxs", () => {
    it("removes transactions correctly", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)

      expect(calc.txCount).toBe(2)
      expect(calc.removeTxs([key1])).toBe(1)
      expect(calc.txCount).toBe(1)
      expect(calc.hasTx(key1)).toBe(false)
      expect(calc.hasTx(key2)).toBe(true)
    })

    it("returns 0 for non-existent key", () => {
      expect(calc.removeTxs(["nonexistent"])).toBe(0)
    })

    it("invalidates when removing from calculated slice", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)
      calc.calculateState()

      expect(calc.needsFullRecalculation()).toBe(false)
      calc.removeTxs([key1])
      expect(calc.needsFullRecalculation()).toBe(true)
    })

    it("does not invalidate when removing after calculated slice", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })

      calc.insertTx(key1, yTx)
      calc.calculateState()

      // Add key2 after calculation
      calc.insertTx(key2, yTx)
      expect(calc.needsFullRecalculation()).toBe(false)

      // Remove key2 (after calculated slice) - should not invalidate
      calc.removeTxs([key2])
      expect(calc.needsFullRecalculation()).toBe(false)
    })

    it("removes multiple transactions efficiently", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")
      const key3 = createTxKey(1, 3, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })
      yTx.set(key3, { ops: [setOp("c", 3)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)
      calc.insertTx(key3, yTx)

      expect(calc.removeTxs([key1, key3])).toBe(2)
      expect(calc.txCount).toBe(1)
      expect(calc.hasTx(key2)).toBe(true)
    })

    it("returns count of actually removed keys", () => {
      const key1 = createTxKey(1, 1, "client1")
      yTx.set(key1, { ops: [setOp("a", 1)] })

      calc.insertTx(key1, yTx)

      expect(calc.removeTxs([key1, "nonexistent"])).toBe(1)
    })

    it("invalidates when removing multiple from calculated slice", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")
      const key3 = createTxKey(1, 3, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })
      yTx.set(key3, { ops: [setOp("c", 3)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)
      calc.insertTx(key3, yTx)
      calc.calculateState()

      expect(calc.needsFullRecalculation()).toBe(false)
      calc.removeTxs([key1, key2])
      expect(calc.needsFullRecalculation()).toBe(true)
    })
  })

  describe("setBaseCheckpoint", () => {
    it("returns true when checkpoint changes", () => {
      const cp1: CheckpointRecord = {
        txCount: 0,
        state: {},
        watermarks: {},
        minWallClock: Date.now(),
      }

      expect(calc.setBaseCheckpoint(cp1)).toBe(true)
      expect(calc.getBaseCheckpoint()).toBe(cp1)
    })

    it("returns false when checkpoint is the same reference", () => {
      const cp1: CheckpointRecord = {
        txCount: 5,
        state: { a: 1 },
        watermarks: {},
        minWallClock: Date.now(),
      }

      calc.setBaseCheckpoint(cp1)
      // Same reference
      expect(calc.setBaseCheckpoint(cp1)).toBe(false)
    })

    it("invalidates state when checkpoint changes", () => {
      const key1 = createTxKey(1, 1, "client1")
      yTx.set(key1, { ops: [setOp("a", 1)] })

      calc.insertTx(key1, yTx)
      calc.calculateState()

      expect(calc.needsFullRecalculation()).toBe(false)

      const cp: CheckpointRecord = {
        txCount: 1,
        state: { existing: true },
        watermarks: {},
        minWallClock: Date.now(),
      }

      calc.setBaseCheckpoint(cp)
      expect(calc.needsFullRecalculation()).toBe(true)
    })
  })

  describe("calculateState", () => {
    it("returns empty state when no transactions", () => {
      const { state, getAppliedOps } = calc.calculateState()
      expect(state).toEqual({})
      expect(getAppliedOps()).toEqual([])
    })

    it("applies transactions in order", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)

      const { state, getAppliedOps } = calc.calculateState()
      expect(state).toEqual({ a: 1, b: 2 })
      expect(getAppliedOps().length).toBe(2)
    })

    it("uses checkpoint state as base", () => {
      const cp: CheckpointRecord = {
        txCount: 1,
        state: { existing: "value" },
        watermarks: {},
        minWallClock: Date.now(),
      }

      calc.setBaseCheckpoint(cp)

      const key1 = createTxKey(2, 1, "client1")
      yTx.set(key1, { ops: [setOp("new", "data")] })
      calc.insertTx(key1, yTx)

      const { state } = calc.calculateState()
      expect(state).toEqual({ existing: "value", new: "data" })
    })

    it("skips transactions already in checkpoint watermarks", () => {
      const cp: CheckpointRecord = {
        txCount: 1,
        state: { a: 1 },
        watermarks: { client1: { maxClock: 5, maxWallClock: Date.now() } },
        minWallClock: Date.now(),
      }

      calc.setBaseCheckpoint(cp)

      // This tx is covered by the checkpoint (clock 3 <= maxClock 5)
      const key1 = createTxKey(2, 3, "client1")
      // This tx is NOT covered (clock 7 > maxClock 5)
      const key2 = createTxKey(2, 7, "client1")

      yTx.set(key1, { ops: [setOp("b", 2)] })
      yTx.set(key2, { ops: [setOp("c", 3)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)

      const { state } = calc.calculateState()
      // key1 should be skipped (already in checkpoint), only key2 applied
      expect(state).toEqual({ a: 1, c: 3 })
    })

    it("deduplicates re-emitted transactions", () => {
      const originalKey = createTxKey(1, 1, "client1")
      const reEmitKey = createTxKey(2, 2, "client1")

      // Original transaction
      yTx.set(originalKey, { ops: [setOp("a", 1)] })
      // Re-emitted transaction with same originalTxKey
      yTx.set(reEmitKey, { ops: [setOp("a", 1)], originalTxKey: originalKey })

      calc.insertTx(originalKey, yTx)
      calc.insertTx(reEmitKey, yTx)

      const { state } = calc.calculateState()
      // Should only apply once
      expect(state).toEqual({ a: 1 })
    })

    it("incrementally applies new transactions", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      calc.insertTx(key1, yTx)

      // First calculation
      const result1 = calc.calculateState()
      expect(result1.state).toEqual({ a: 1 })
      expect(result1.getAppliedOps().length).toBe(1)

      // Add another transaction
      yTx.set(key2, { ops: [setOp("b", 2)] })
      calc.insertTx(key2, yTx)

      // Second calculation should be incremental
      expect(calc.needsFullRecalculation()).toBe(false)
      const result2 = calc.calculateState()
      expect(result2.state).toEqual({ a: 1, b: 2 })
      expect(result2.getAppliedOps().length).toBe(1) // Only the new op
    })

    it("does full recalculation after invalidation", () => {
      const key1 = createTxKey(1, 2, "client1")
      const key2 = createTxKey(1, 3, "client1")
      const key0 = createTxKey(1, 1, "client1")

      yTx.set(key1, { ops: [setOp("b", 2)] })
      yTx.set(key2, { ops: [setOp("c", 3)] })
      yTx.set(key0, { ops: [setOp("a", 1)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)
      calc.calculateState()

      // Insert before calculated slice - causes invalidation
      calc.insertTx(key0, yTx)
      expect(calc.needsFullRecalculation()).toBe(true)

      const result = calc.calculateState()
      expect(result.state).toEqual({ a: 1, b: 2, c: 3 })
      // Ops represent the diff from previous cached state (b:2, c:3) to new state (a:1, b:2, c:3)
      // So only 1 op (adding 'a')
      expect(result.getAppliedOps().length).toBe(1)
    })
  })

  describe("rebuildFromYjs", () => {
    it("rebuilds sorted cache from yTx", () => {
      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")
      const key3 = createTxKey(1, 3, "client1")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })
      yTx.set(key3, { ops: [setOp("c", 3)] })

      calc.rebuildFromYjs(yTx)

      const sorted = calc.getSortedTxs()
      expect(sorted.length).toBe(3)
      expect(sorted[0].txTimestampKey).toBe(key1)
      expect(sorted[1].txTimestampKey).toBe(key2)
      expect(sorted[2].txTimestampKey).toBe(key3)
    })

    it("clears existing cache before rebuilding", () => {
      const key1 = createTxKey(1, 1, "client1")
      yTx.set(key1, { ops: [setOp("a", 1)] })

      calc.insertTx(key1, yTx)
      expect(calc.txCount).toBe(1)

      // Remove from yTx and rebuild
      yTx.delete(key1)
      calc.rebuildFromYjs(yTx)

      expect(calc.txCount).toBe(0)
    })

    it("invalidates cached state", () => {
      const key1 = createTxKey(1, 1, "client1")
      yTx.set(key1, { ops: [setOp("a", 1)] })

      calc.insertTx(key1, yTx)
      calc.calculateState()
      expect(calc.needsFullRecalculation()).toBe(false)

      calc.rebuildFromYjs(yTx)
      expect(calc.needsFullRecalculation()).toBe(true)
    })

    it("updates maxSeenClock", () => {
      const key1 = createTxKey(1, 5, "client1")
      const key2 = createTxKey(1, 15, "client2")

      yTx.set(key1, { ops: [setOp("a", 1)] })
      yTx.set(key2, { ops: [setOp("b", 2)] })

      calc.rebuildFromYjs(yTx)
      expect(calc.getMaxSeenClock()).toBe(15)
    })
  })

  describe("validation", () => {
    it("skips invalid transactions", () => {
      const validateFn = (state: JSONObject) => {
        // Reject if 'blocked' key would be set
        return !("blocked" in state)
      }

      calc = new StateCalculator(validateFn)

      const key1 = createTxKey(1, 1, "client1")
      const key2 = createTxKey(1, 2, "client1")

      yTx.set(key1, { ops: [setOp("blocked", true)] })
      yTx.set(key2, { ops: [setOp("allowed", true)] })

      calc.insertTx(key1, yTx)
      calc.insertTx(key2, yTx)

      const { state } = calc.calculateState()
      expect(state).toEqual({ allowed: true })
    })
  })
})
