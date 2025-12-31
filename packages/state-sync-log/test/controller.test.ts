import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Controller API", () => {
  it("initializes with empty state", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog({ yDoc: doc, retentionWindowMs: undefined })
    expect(log.getState()).toStrictEqual({})
    expect(log.isLogEmpty()).toBe(true)
  })

  it("subscribes to changes", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()
    log.subscribe(spy)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ a: 1 }, [{ kind: "set", path: [], key: "a", value: 1 }])
  })

  it("unsubscribe stops callback from firing", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()

    const unsubscribe = log.subscribe(spy)
    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(spy).toHaveBeenCalledTimes(1)

    unsubscribe()

    log.emit([{ kind: "set", path: [], key: "b", value: 2 }])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("multiple subscribers all receive updates", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    const spy1 = vi.fn()
    const spy2 = vi.fn()
    const spy3 = vi.fn()

    log.subscribe(spy1)
    log.subscribe(spy2)
    log.subscribe(spy3)

    log.emit([{ kind: "set", path: [], key: "x", value: 1 }])

    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
    expect(spy3).toHaveBeenCalledTimes(1)
  })

  it("disposes correctly and stops firing subscriptions", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()

    log.subscribe(spy)
    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(spy).toHaveBeenCalledTimes(1)

    log.dispose()

    // Double dispose should not throw (it's a no-op)
    expect(() => log.dispose()).not.toThrow()

    // All other methods should throw after disposal
    const errMsg = "StateSyncLog has been disposed"
    expect(() => log.getState()).toThrow(errMsg)
    expect(() => log.emit([{ kind: "set", path: [], key: "b", value: 2 }])).toThrow(errMsg)
    expect(() => log.reconcileState({ x: 1 })).toThrow(errMsg)
    expect(() => log.compact()).toThrow(errMsg)
    expect(() => log.subscribe(() => {})).toThrow(errMsg)
    expect(() => log.getActiveEpoch()).toThrow(errMsg)
    expect(() => log.getActiveEpochTxCount()).toThrow(errMsg)
    expect(() => log.getActiveEpochStartTime()).toThrow(errMsg)
    expect(() => log.isLogEmpty()).toThrow(errMsg)
  })

  it("tracks getActiveEpochTxCount correctly", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    expect(log.getActiveEpochTxCount()).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(log.getActiveEpochTxCount()).toBeGreaterThan(0)
  })

  it("tracks getActiveEpochStartTime correctly", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Before any transactions
    expect(log.getActiveEpochStartTime()).toBeUndefined()

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    // After emit, before compact - should have timestamp
    expect(log.getActiveEpochStartTime()).toBeDefined()
    expect(typeof log.getActiveEpochStartTime()).toBe("number")

    log.compact()

    // After compact - new epoch has no transactions
    expect(log.getActiveEpochStartTime()).toBeUndefined()
  })

  it("handles empty emit array", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()

    log.subscribe(spy)
    log.emit([])

    // Empty emit should not trigger subscriber
    expect(spy).not.toHaveBeenCalled()
    expect(log.getState()).toStrictEqual({})
  })

  it("getActiveEpoch returns current epoch number", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    expect(log.getActiveEpoch()).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    log.compact()

    expect(log.getActiveEpoch()).toBe(1)
  })

  it("isLogEmpty returns true only when both tx and checkpoints are empty", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    expect(log.isLogEmpty()).toBe(true)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(log.isLogEmpty()).toBe(false)

    log.compact()
    expect(log.isLogEmpty()).toBe(false) // Checkpoint exists
  })
})
