import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { applyOps, createStateSyncLog, type Op } from "../src/index"
import { compareTxTimestamps, parseTxTimestampKey } from "../src/txTimestamp"

describe("Operations", () => {
  it("handles basic set operations", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "count", value: 1 }])
    expect(log.getState()).toStrictEqual({ count: 1 })
    expect(log.isLogEmpty()).toBe(false)
  })

  it("handles nested updates", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "user", value: { name: "Alice", age: 30 } }])
    expect(log.getState()).toStrictEqual({ user: { name: "Alice", age: 30 } })

    log.emit([{ kind: "set", path: ["user"], key: "age", value: 31 }])
    expect(log.getState()).toStrictEqual({ user: { name: "Alice", age: 31 } })
  })

  it("handles deletion", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "temp", value: "foo" }])
    expect(log.getState()).toStrictEqual({ temp: "foo" })

    log.emit([{ kind: "delete", path: [], key: "temp" }])
    expect(log.getState()).toStrictEqual({})
  })

  it("handles array splice", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "list", value: [1, 2, 3] }])
    expect(log.getState()).toStrictEqual({ list: [1, 2, 3] })

    log.emit([{ kind: "splice", path: ["list"], index: 1, deleteCount: 1, inserts: [4, 5] }])
    expect(log.getState()).toStrictEqual({ list: [1, 4, 5, 3] })
  })

  it("handles addToSet / deleteFromSet", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "tags", value: [] }])

    log.emit([{ kind: "addToSet", path: ["tags"], value: "red" }])
    expect(log.getState().tags).toStrictEqual(["red"])

    // Duplicate add should be ignored
    log.emit([{ kind: "addToSet", path: ["tags"], value: "red" }])
    expect(log.getState().tags).toStrictEqual(["red"])

    log.emit([{ kind: "addToSet", path: ["tags"], value: "blue" }])
    expect(log.getState().tags).toStrictEqual(["red", "blue"])

    log.emit([{ kind: "deleteFromSet", path: ["tags"], value: "red" }])
    expect(log.getState().tags).toStrictEqual(["blue"])
  })

  it("deleteFromSet removes all matching items", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: ["a", "b", "a", "c", "a"] }])
    log.emit([{ kind: "deleteFromSet", path: ["arr"], value: "a" }])

    expect(log.getState().arr).toStrictEqual(["b", "c"])
  })

  it("handles array path segments with numeric index", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([
      { kind: "set", path: [], key: "arr", value: [{ name: "first" }, { name: "second" }] },
    ])

    log.emit([{ kind: "set", path: ["arr", 1], key: "name", value: "updated" }])
    expect(log.getState().arr[1].name).toBe("updated")
  })

  it("handles splice with out-of-bounds index safely", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "splice", path: ["arr"], index: 100, deleteCount: 0, inserts: [4] }])

    expect(log.getState().arr).toStrictEqual([1, 2, 3, 4])
  })

  it("handles negative splice index", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "splice", path: ["arr"], index: -1, deleteCount: 0, inserts: [99] }])

    // JavaScript splice with -1 inserts before last element
    expect(log.getState().arr).toStrictEqual([1, 2, 99, 3])
  })

  it("handles complex objects as addToSet values", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "items", value: [] }])
    log.emit([{ kind: "addToSet", path: ["items"], value: { id: 1, name: "first" } }])
    log.emit([{ kind: "addToSet", path: ["items"], value: { id: 2, name: "second" } }])

    // Duplicate should be ignored (deep equality)
    log.emit([{ kind: "addToSet", path: ["items"], value: { id: 1, name: "first" } }])

    expect(log.getState().items).toStrictEqual([
      { id: 1, name: "first" },
      { id: 2, name: "second" },
    ])
  })

  it("deleteFromSet with complex objects uses deep equality", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([
      {
        kind: "set",
        path: [],
        key: "items",
        value: [
          { id: 1, name: "first" },
          { id: 2, name: "second" },
          { id: 1, name: "first" },
        ],
      },
    ])

    log.emit([{ kind: "deleteFromSet", path: ["items"], value: { id: 1, name: "first" } }])

    expect(log.getState().items).toStrictEqual([{ id: 2, name: "second" }])
  })

  it("applies multiple operations in a single tx atomically", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([
      { kind: "set", path: [], key: "a", value: 1 },
      { kind: "set", path: [], key: "b", value: 2 },
      { kind: "set", path: [], key: "c", value: 3 },
    ])

    expect(log.getState()).toStrictEqual({ a: 1, b: 2, c: 3 })
  })

  it("handles splice with excessive deleteCount (clamped to available)", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    // deleteCount=100 should only delete remaining elements (3 - index 1 = 2 elements)
    log.emit([{ kind: "splice", path: ["arr"], index: 1, deleteCount: 100, inserts: [99] }])

    expect(log.getState().arr).toStrictEqual([1, 99])
  })

  it("deleteFromSet on non-existing value is a no-op", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: ["a", "b", "c"] }])
    log.emit([{ kind: "deleteFromSet", path: ["arr"], value: "nonexistent" }])

    expect(log.getState().arr).toStrictEqual(["a", "b", "c"])
  })

  it("throws on malformed timestamp key", () => {
    expect(() => parseTxTimestampKey("invalid")).toThrow(/Malformed timestamp key/)
  })

  it("compares identical timestamps correctly", () => {
    const ts = { epoch: 1, clock: 1, clientId: "A", wallClock: 100 }
    expect(compareTxTimestamps(ts, ts)).toBe(0)
  })
})

describe("applyOps", () => {
  it("clones values by default", () => {
    const target: any = {}
    const valueToSet = { nested: { deep: 1 } }
    const ops: Op[] = [{ kind: "set", path: [], key: "x", value: valueToSet }]

    applyOps(ops, target)

    // Value should be cloned
    expect(target.x).not.toBe(valueToSet)
    expect(target.x.nested).not.toBe(valueToSet.nested)
    expect(target.x).toStrictEqual(valueToSet)
  })

  it("clones values when cloneValues is true", () => {
    const target: any = {}
    const valueToSet = { nested: { deep: 1 } }
    const ops: Op[] = [{ kind: "set", path: [], key: "x", value: valueToSet }]

    applyOps(ops, target, { cloneValues: true })

    // Value should be cloned
    expect(target.x).not.toBe(valueToSet)
    expect(target.x).toStrictEqual(valueToSet)
  })

  it("uses values directly when cloneValues is false", () => {
    const target: any = {}
    const valueToSet = { nested: { deep: 1 } }
    const ops: Op[] = [{ kind: "set", path: [], key: "x", value: valueToSet }]

    applyOps(ops, target, { cloneValues: false })

    // Value should be used directly (same reference)
    expect(target.x).toBe(valueToSet)
    expect(target.x.nested).toBe(valueToSet.nested)
  })

  it("clones splice inserts by default", () => {
    const target: any = { arr: [] }
    const objToInsert = { id: 1 }
    const ops: Op[] = [
      { kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [objToInsert] },
    ]

    applyOps(ops, target)

    expect(target.arr[0]).not.toBe(objToInsert)
    expect(target.arr[0]).toStrictEqual(objToInsert)
  })

  it("uses splice inserts directly when cloneValues is false", () => {
    const target: any = { arr: [] }
    const objToInsert = { id: 1 }
    const ops: Op[] = [
      { kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [objToInsert] },
    ]

    applyOps(ops, target, { cloneValues: false })

    expect(target.arr[0]).toBe(objToInsert)
  })

  it("clones addToSet values by default", () => {
    const target: any = { set: [] }
    const objToAdd = { id: 1 }
    const ops: Op[] = [{ kind: "addToSet", path: ["set"], value: objToAdd }]

    applyOps(ops, target)

    expect(target.set[0]).not.toBe(objToAdd)
    expect(target.set[0]).toStrictEqual(objToAdd)
  })

  it("uses addToSet values directly when cloneValues is false", () => {
    const target: any = { set: [] }
    const objToAdd = { id: 1 }
    const ops: Op[] = [{ kind: "addToSet", path: ["set"], value: objToAdd }]

    applyOps(ops, target, { cloneValues: false })

    expect(target.set[0]).toBe(objToAdd)
  })
})
