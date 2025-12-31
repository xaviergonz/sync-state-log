import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Checkpoints", () => {
  it("compacts epoch and maintains state", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    const epoch1 = log.getActiveEpoch()

    log.compact()

    expect(log.getActiveEpoch()).toBe(epoch1 + 1)
    expect(log.getState()).toStrictEqual({ a: 1 })
    expect(log.isLogEmpty()).toBe(false)
  })

  it("multiple compact calls increment epochs correctly", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    const epoch0 = log.getActiveEpoch()
    expect(epoch0).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    log.compact()
    expect(log.getActiveEpoch()).toBe(1)

    log.emit([{ kind: "set", path: [], key: "b", value: 2 }])
    log.compact()
    expect(log.getActiveEpoch()).toBe(2)

    log.emit([{ kind: "set", path: [], key: "c", value: 3 }])
    log.compact()
    expect(log.getActiveEpoch()).toBe(3)

    expect(log.getState()).toStrictEqual({ a: 1, b: 2, c: 3 })
  })

  it("preserves state after multiple compacts with no new transactions", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "persistent", value: 42 }])
    log.compact()

    log.compact()
    log.compact()

    expect(log.getState()).toStrictEqual({ persistent: 42 })
  })

  it("new client loads checkpointed state", () => {
    const doc = new Y.Doc()
    const log1 = createStateSyncLog<any>({ yDoc: doc, clientId: "A", retentionWindowMs: undefined })

    log1.emit([{ kind: "set", path: [], key: "data", value: { preserved: true } }])
    log1.compact()

    const log2 = createStateSyncLog<any>({ yDoc: doc, clientId: "B", retentionWindowMs: undefined })

    expect(log2.getState()).toStrictEqual({ data: { preserved: true } })
  })

  it("compact does nothing when epoch is empty", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    expect(log.getActiveEpoch()).toBe(0)

    log.compact() // Should be no-op

    expect(log.getActiveEpoch()).toBe(0) // Still epoch 0
  })

  it("transactions after compact are in new epoch", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "before", value: 1 }])
    log.compact()

    const epochAfterCompact = log.getActiveEpoch()

    log.emit([{ kind: "set", path: [], key: "after", value: 2 }])

    expect(log.getActiveEpoch()).toBe(epochAfterCompact)
    expect(log.getState()).toStrictEqual({ before: 1, after: 2 })
  })
})
