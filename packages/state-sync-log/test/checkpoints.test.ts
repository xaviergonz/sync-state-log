import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { CheckpointRecord, parseCheckpointKey } from "../src/checkpoints"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"

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

  it("preserves state after multiple compacts with no new txs", () => {
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

  it("txs after compact are in new epoch", () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "before", value: 1 }])
    log.compact()

    const epochAfterCompact = log.getActiveEpoch()

    log.emit([{ kind: "set", path: [], key: "after", value: 2 }])

    expect(log.getActiveEpoch()).toBe(epochAfterCompact)
    // State should have both (old was in checkpoint, new is fresh)
    expect(log.getState()).toStrictEqual({ before: 1, after: 2 })
  })

  it("throws on malformed checkpoint key", () => {
    expect(() => parseCheckpointKey("invalid")).toThrow(/Malformed checkpoint key/)
    expect(() => parseCheckpointKey("1;2")).toThrow(/Malformed checkpoint key/)
  })

  it("includes active txs in checkpoint", () => {
    const doc = new Y.Doc()

    const log = createStateSyncLog<any>({
      yDoc: doc,
      clientId: "A",
      retentionWindowMs: 1000,
    })

    // Access internal map for checkpoint verification (no public API for watermarks yet)
    const yCheckpoint = doc.getMap<CheckpointRecord>("state-sync-log-checkpoint")

    // Add a tx in epoch 1
    log.emit([])

    // Verify tx exists before compact
    expect(log[getSortedTxsSymbol]().length).toBe(1)

    // Compact (creates checkpoint for epoch 1 and prunes txs)
    log.compact()

    // Checkpoint should be created
    expect(yCheckpoint.size).toBe(1)
    // The tx should have been pruned
    expect(log[getSortedTxsSymbol]().length).toBe(0)
  })
})
