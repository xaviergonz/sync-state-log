import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Reconcile", () => {
  it("reconciles state via diffs", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.reconcileState({ a: 1, b: 2 })
    expect(log.getState()).toStrictEqual({ a: 1, b: 2 })

    log.reconcileState({ a: 1, b: 3, c: 4 })
    expect(log.getState()).toStrictEqual({ a: 1, b: 3, c: 4 })
  })

  it("reconciles deeply nested state correctly", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    const target = {
      level1: {
        level2: {
          level3: {
            value: "deep",
            array: [1, 2, 3],
          },
        },
      },
    }

    log.reconcileState(target)
    expect(log.getState()).toStrictEqual(target)

    const updated = {
      level1: {
        level2: {
          level3: {
            value: "deeper",
            array: [1, 2, 3, 4],
          },
        },
      },
    }

    log.reconcileState(updated)
    expect(log.getState()).toStrictEqual(updated)
  })

  it("reconcile handles array shrinking", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.reconcileState({ arr: [1, 2, 3, 4, 5] })
    expect(log.getState().arr).toStrictEqual([1, 2, 3, 4, 5])

    log.reconcileState({ arr: [1, 2] })
    expect(log.getState().arr).toStrictEqual([1, 2])
  })

  it("reconcile handles array growing", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.reconcileState({ arr: [1, 2] })
    expect(log.getState().arr).toStrictEqual([1, 2])

    log.reconcileState({ arr: [1, 2, 3, 4, 5] })
    expect(log.getState().arr).toStrictEqual([1, 2, 3, 4, 5])
  })

  it("reconcile handles primitive value changes", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.reconcileState({ num: 1, str: "hello", bool: true, nil: null })
    expect(log.getState()).toStrictEqual({ num: 1, str: "hello", bool: true, nil: null })

    log.reconcileState({ num: 2, str: "world", bool: false, nil: null })
    expect(log.getState()).toStrictEqual({ num: 2, str: "world", bool: false, nil: null })
  })

  it("reconcile handles key deletion", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.reconcileState({ a: 1, b: 2, c: 3 })
    expect(log.getState()).toStrictEqual({ a: 1, b: 2, c: 3 })

    log.reconcileState({ a: 1 })
    expect(log.getState()).toStrictEqual({ a: 1 })
  })

  it("reconcile is idempotent", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()
    log.subscribe(spy)

    const state = { x: 1, y: [1, 2, 3], z: { nested: true } }

    log.reconcileState(state)
    expect(log.getState()).toStrictEqual(state)
    expect(spy).toHaveBeenCalledTimes(1)

    // Reconciling same state should produce no ops and not trigger subscriber
    log.reconcileState(state)
    expect(log.getState()).toStrictEqual(state)
    expect(spy).toHaveBeenCalledTimes(1) // Still only 1 call
  })
})
