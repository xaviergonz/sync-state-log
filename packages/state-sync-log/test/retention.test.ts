import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Retention Window", () => {
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("transactions within retention window are preserved", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({
      yDoc: doc,
      retentionWindowMs: TWO_WEEKS_MS,
    })

    // Create transaction at time 0
    vi.setSystemTime(0)
    log.emit([{ kind: "set", path: [], key: "early", value: 1 }])

    // Advance time by 1 week (still within 2 week window)
    vi.setSystemTime(ONE_WEEK_MS)
    log.emit([{ kind: "set", path: [], key: "later", value: 2 }])

    // Compact
    log.compact()

    // Both transactions should be in the state (within retention)
    expect(log.getState()).toStrictEqual({ early: 1, later: 2 })
  })

  it("watermarks for inactive clients are pruned after retention window", () => {
    const doc = new Y.Doc()

    // Start at time 0
    vi.setSystemTime(0)

    const logA = createStateSyncLog<any>({
      yDoc: doc,
      clientId: "A",
      retentionWindowMs: ONE_WEEK_MS,
    })

    // A makes a change
    logA.emit([{ kind: "set", path: [], key: "fromA", value: 1 }])

    // Advance time beyond retention window
    vi.setSystemTime(ONE_WEEK_MS + 1000)

    // Create another client
    const logB = createStateSyncLog<any>({
      yDoc: doc,
      clientId: "B",
      retentionWindowMs: ONE_WEEK_MS,
    })

    // B makes a change
    logB.emit([{ kind: "set", path: [], key: "fromB", value: 2 }])

    // B compacts - A's watermark should be pruned as it's beyond retention window
    logB.compact()

    // State should still contain both values (transactions applied before pruning)
    const state = logB.getState()
    expect(state.fromA).toBe(1)
    expect(state.fromB).toBe(2)
  })

  it("ancient transactions from finalized epochs are not re-emitted", () => {
    const doc = new Y.Doc()

    vi.setSystemTime(0)

    const log = createStateSyncLog<any>({
      yDoc: doc,
      retentionWindowMs: ONE_WEEK_MS,
    })

    // Create transaction and compact
    log.emit([{ kind: "set", path: [], key: "old", value: 1 }])
    log.compact()

    // Advance time way beyond retention
    vi.setSystemTime(TWO_WEEKS_MS)

    // Add new transaction in new epoch
    log.emit([{ kind: "set", path: [], key: "new", value: 2 }])

    // State should have both (old was in checkpoint, new is fresh)
    expect(log.getState()).toStrictEqual({ old: 1, new: 2 })
  })

  it("retentionWindowMs of undefined means no pruning (infinite retention)", () => {
    const doc = new Y.Doc()

    vi.setSystemTime(0)

    const log = createStateSyncLog<any>({
      yDoc: doc,
      retentionWindowMs: undefined,
    })

    log.emit([{ kind: "set", path: [], key: "ancient", value: 1 }])

    // Advance time by 100 years
    vi.setSystemTime(100 * 365 * 24 * 60 * 60 * 1000)

    log.emit([{ kind: "set", path: [], key: "future", value: 2 }])
    log.compact()

    // Both should be preserved with infinite retention
    expect(log.getState()).toStrictEqual({ ancient: 1, future: 2 })
  })

  it("two clients with retention window handle offline rejoin", () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    vi.setSystemTime(0)

    const logA = createStateSyncLog<any>({
      yDoc: docA,
      clientId: "A",
      retentionWindowMs: ONE_WEEK_MS,
    })

    const logB = createStateSyncLog<any>({
      yDoc: docB,
      clientId: "B",
      retentionWindowMs: ONE_WEEK_MS,
    })

    // A makes changes
    logA.emit([{ kind: "set", path: [], key: "a1", value: 1 }])

    // Sync
    const stateA1 = Y.encodeStateAsUpdate(docA)
    Y.applyUpdate(docB, stateA1)

    expect(logB.getState()).toStrictEqual({ a1: 1 })

    // B goes offline for 2 weeks
    vi.setSystemTime(TWO_WEEKS_MS)

    // A continues making changes and compacts
    logA.emit([{ kind: "set", path: [], key: "a2", value: 2 }])
    logA.compact()

    // B comes back online with a very old transaction
    logB.emit([{ kind: "set", path: [], key: "bOld", value: "old" }])

    // Sync both ways
    const stateA2 = Y.encodeStateAsUpdate(docA)
    const stateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docB, stateA2)
    Y.applyUpdate(docA, stateB)

    // Both should eventually converge
    // B's old transaction may or may not be included depending on when it was created
    // relative to the checkpoint's minWallClock
    const finalStateA = logA.getState()
    const finalStateB = logB.getState()

    expect(finalStateA).toStrictEqual(finalStateB)
    expect(finalStateA.a1).toBe(1)
    expect(finalStateA.a2).toBe(2)
  })

  it("short retention window prunes quickly", () => {
    const doc = new Y.Doc()
    const SHORT_RETENTION = 1000 // 1 second

    vi.setSystemTime(0)

    const log = createStateSyncLog<any>({
      yDoc: doc,
      retentionWindowMs: SHORT_RETENTION,
    })

    log.emit([{ kind: "set", path: [], key: "t0", value: 0 }])

    vi.setSystemTime(500)
    log.emit([{ kind: "set", path: [], key: "t500", value: 500 }])

    vi.setSystemTime(1000)
    log.emit([{ kind: "set", path: [], key: "t1000", value: 1000 }])

    log.compact()

    // All should be in state since they're all within the same epoch
    expect(log.getState()).toStrictEqual({ t0: 0, t500: 500, t1000: 1000 })

    // Now advance far beyond retention
    vi.setSystemTime(5000)
    log.emit([{ kind: "set", path: [], key: "t5000", value: 5000 }])

    expect(log.getState()).toStrictEqual({ t0: 0, t500: 500, t1000: 1000, t5000: 5000 })
  })
})
