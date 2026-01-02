import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { applyOps, createStateSyncLog, type Op } from "../src/index"

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

describe("applyOps validation", () => {
  it("throws when setting on non-object", () => {
    const target: any = { arr: [] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: "prop", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/set requires object container/)
  })

  it("throws when deleting from non-object", () => {
    const target: any = { arr: [] }
    const ops: Op[] = [{ kind: "delete", path: ["arr"], key: "prop" }]
    expect(() => applyOps(ops, target)).toThrow(/delete requires object container/)
  })

  it("throws when splicing non-array", () => {
    const target: any = { obj: {} }
    const ops: Op[] = [{ kind: "splice", path: ["obj"], index: 0, deleteCount: 0, inserts: [] }]
    expect(() => applyOps(ops, target)).toThrow(/splice requires array container/)
  })

  it("throws when adding to set on non-array", () => {
    const target: any = { obj: {} }
    const ops: any[] = [{ kind: "addToSet", path: ["obj"], value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/addToSet requires array container/)
  })

  it("throws when deleting from set on non-array", () => {
    const target: any = { obj: {} }
    const ops: any[] = [{ kind: "deleteFromSet", path: ["obj"], value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/deleteFromSet requires array container/)
  })

  it("throws on unknown op kind", () => {
    const target: any = {}
    const ops: any[] = [{ kind: "unknown", path: [], key: "a" }]
    expect(() => applyOps(ops, target)).toThrow(/Unknown operation kind/)
  })

  it("throws when path segment is string for array container", () => {
    const target: any = { arr: [] }
    const ops: Op[] = [{ kind: "set", path: ["arr", "key"], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Expected object at path segment "key"/)
  })

  it("throws when path property does not exist", () => {
    const target: any = { obj: {} }
    const ops: Op[] = [{ kind: "set", path: ["obj", "missing", "key"], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Property "missing" does not exist/)
  })

  it("throws when path segment is number for object container", () => {
    const target: any = { obj: {} }
    const ops: any[] = [{ kind: "set", path: ["obj", 0], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Expected array at path segment 0/)
  })

  it("throws when path index is out of bounds", () => {
    const target: any = { arr: [1] }
    const ops: any[] = [{ kind: "set", path: ["arr", 5], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Index 5 out of bounds/)
  })
})

describe("applyOps success features", () => {
  it("applies delete operation", () => {
    const target: any = { a: 1, b: 2 }
    applyOps([{ kind: "delete", path: [], key: "a" }], target)
    expect(target).toStrictEqual({ b: 2 })
    expect(target.a).toBeUndefined()
  })

  it("applies deleteFromSet operation", () => {
    const target: any = { arr: ["a", "b", "a"] }
    applyOps([{ kind: "deleteFromSet", path: ["arr"], value: "a" }], target)
    expect(target.arr).toStrictEqual(["b"])
  })

  it("applies splice operation (delete)", () => {
    const target: any = { arr: [1, 2, 3] }
    applyOps([{ kind: "splice", path: ["arr"], index: 1, deleteCount: 1, inserts: [] }], target)
    expect(target.arr).toStrictEqual([1, 3])
  })
})
