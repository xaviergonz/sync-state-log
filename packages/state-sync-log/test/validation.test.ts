import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Validation", () => {
  it("validates state changes", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({
      yDoc: doc,
      retentionWindowMs: undefined,
      validate: (state) => typeof state.count === "number" && state.count >= 0,
    })

    log.emit([{ kind: "set", path: [], key: "count", value: 10 }])
    expect(log.getState()).toStrictEqual({ count: 10 })

    // Invalid op should be rejected (state remains same)
    log.emit([{ kind: "set", path: [], key: "count", value: -5 }])
    expect(log.getState()).toStrictEqual({ count: 10 })
  })

  it("rejects operations targeting non-existent paths", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: ["nonexistent"], key: "foo", value: 1 }])
    expect(log.getState()).toStrictEqual({})
  })

  it("rejects set operation on array container", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "set", path: ["arr"], key: "foo", value: "bar" }])

    expect(log.getState().arr).toStrictEqual([1, 2, 3])
  })

  it("rejects delete operation on array container", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "delete", path: ["arr"], key: "0" }])

    expect(log.getState().arr).toStrictEqual([1, 2, 3])
  })

  it("rejects splice operation on object container", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "obj", value: { a: 1 } }])
    log.emit([{ kind: "splice", path: ["obj"], index: 0, deleteCount: 1, inserts: [] }])

    expect(log.getState().obj).toStrictEqual({ a: 1 })
  })

  it("rejects addToSet operation on object container", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "obj", value: { a: 1 } }])
    log.emit([{ kind: "addToSet", path: ["obj"], value: "new" }])

    expect(log.getState().obj).toStrictEqual({ a: 1 })
  })

  it("rejects deleteFromSet operation on object container", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "obj", value: { a: 1 } }])
    log.emit([{ kind: "deleteFromSet", path: ["obj"], value: "a" }])

    expect(log.getState().obj).toStrictEqual({ a: 1 })
  })

  it("partial transaction failure rejects entire transaction", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    log.emit([
      { kind: "set", path: [], key: "b", value: 2 },
      { kind: "set", path: ["nonexistent"], key: "c", value: 3 },
    ])

    expect(log.getState()).toStrictEqual({ a: 1 })
  })

  it("throws if clientId contains a semicolon", () => {
    const doc = new Y.Doc()
    expect(() =>
      createStateSyncLog({ yDoc: doc, clientId: "user;1", retentionWindowMs: undefined })
    ).toThrow("clientId MUST NOT contain semicolons")
  })

  it("handles validation function that throws", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({
      yDoc: doc,
      retentionWindowMs: undefined,
      validate: (state) => {
        if (state.trigger === "error") {
          throw new Error("Validation exploded!")
        }
        return true
      },
    })

    log.emit([{ kind: "set", path: [], key: "safe", value: 1 }])
    expect(log.getState()).toStrictEqual({ safe: 1 })

    // This should not throw but reject the transaction
    log.emit([{ kind: "set", path: [], key: "trigger", value: "error" }])
    expect(log.getState()).toStrictEqual({ safe: 1 }) // State unchanged
  })
})
