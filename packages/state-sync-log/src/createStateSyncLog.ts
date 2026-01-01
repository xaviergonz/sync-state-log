import * as Y from "yjs"
import { CheckpointRecord, createCheckpoint } from "./checkpoints"
import { createClientState } from "./clientState"
import { failure } from "./error"
import { JSONObject } from "./json"

import { Op, ValidateFn } from "./operations"

import { computeReconcileOps } from "./reconcile"
import { SortedTxEntry } from "./SortedTxEntry"
import { TxRecord } from "./TxRecord"
import { appendTx, TxKeyChanges, updateState } from "./txLog"
import { TxTimestampKey } from "./txTimestamp"
import { generateID } from "./utils"

export const getSortedTxsSymbol = Symbol("getSortedTxs")

export interface StateSyncLogOptions<State extends JSONObject> {
  /**
   * The Y.js Document to bind to.
   */
  yDoc: Y.Doc

  /**
   * Name for the txs Y.Map.
   * Default: "state-sync-log-tx"
   */
  yTxMapName?: string

  /**
   * Name for the checkpoint Y.Map.
   * Default: "state-sync-log-checkpoint"
   */
  yCheckpointMapName?: string

  /**
   * Unique identifier for this client.
   * If omitted, a random UUID (nanoid) will be generated.
   * NOTE: If you need to resume a session (keep local clock/watermark), you MUST provide a stable ID.
   * MUST NOT contain semicolons.
   */
  clientId?: string

  /**
   * Origin tag for Y.js txs created by this library.
   */
  yjsOrigin?: unknown

  /**
   * Optional validation function.
   * Runs after each tx's ops are applied.
   * If it returns false, the tx is rejected (state reverts).
   * MUST be deterministic and consistent across all clients.
   */
  validate?: (state: State) => boolean

  /**
   * Timestamp retention window in milliseconds.
   * Txs older than this window are considered "Ancient" and pruned.
   *
   * Default: Infinity (No pruning).
   * Recommended: 14 days (1209600000 ms).
   */
  retentionWindowMs: number | undefined
}

export interface StateSyncLogController<State extends JSONObject> {
  /**
   * Returns the current state.
   */
  getState(): State

  /**
   * Subscribes to state changes.
   */
  subscribe(callback: (newState: State, appliedOps: readonly Op[]) => void): () => void

  /**
   * Emits a new tx (list of operations) to the log.
   */
  emit(ops: Op[]): void

  /**
   * Reconciles the current state with the target state.
   */
  reconcileState(targetState: State): void

  /**
   * Manually triggers epoch compaction (Checkpointing).
   */
  compact(): void

  /**
   * Cleans up observers and releases memory.
   */
  dispose(): void

  // --- Observability & Stats ---

  /**
   * Returns the current active epoch number.
   */
  getActiveEpoch(): number

  /**
   * Returns the number of txs currently in the active epoch.
   */
  getActiveEpochTxCount(): number

  /**
   * Returns the wallClock timestamp of the first tx in the active epoch.
   */
  getActiveEpochStartTime(): number | undefined

  /**
   * Returns true if the log is completely empty.
   */
  isLogEmpty(): boolean

  /**
   * Internal/Testing: Returns all txs currently in the log, sorted.
   */
  [getSortedTxsSymbol](): SortedTxEntry[]
}

/**
 * Creates a StateSyncLog controller.
 */
export function createStateSyncLog<State extends JSONObject>(
  options: StateSyncLogOptions<State>
): StateSyncLogController<State> {
  const {
    yDoc,
    yTxMapName = "state-sync-log-tx",
    yCheckpointMapName = "state-sync-log-checkpoint",
    clientId = generateID(),
    yjsOrigin,
    validate,
    retentionWindowMs,
  } = options

  if (clientId.includes(";")) {
    failure(`clientId MUST NOT contain semicolons: ${clientId}`)
  }

  const yTx = yDoc.getMap<TxRecord>(yTxMapName)
  const yCheckpoint = yDoc.getMap<CheckpointRecord>(yCheckpointMapName)

  // Cast validate to basic type to match internal ClientState
  const clientState = createClientState(
    validate as unknown as ValidateFn<JSONObject>,
    retentionWindowMs ?? Number.POSITIVE_INFINITY
  )

  // Listeners
  const subscribers = new Set<(state: State, ops: readonly Op[]) => void>()

  const notifySubscribers = (state: State, ops: readonly Op[]) => {
    for (const sub of subscribers) {
      sub(state, ops)
    }
  }

  // Helper to extract key changes from YMapEvent
  const extractTxChanges = (event: Y.YMapEvent<TxRecord>): TxKeyChanges => {
    const added: TxTimestampKey[] = []
    const deleted: TxTimestampKey[] = []

    for (const [key, change] of event.changes.keys) {
      if (change.action === "add") {
        added.push(key)
      } else if (change.action === "delete") {
        deleted.push(key)
      } else if (change.action === "update") {
        deleted.push(key)
        added.push(key)
      }
    }

    return { added, deleted }
  }

  // Empty txChanges object for checkpoint observer (no tx keys changed)
  const emptyTxChanges: TxKeyChanges = { added: [], deleted: [] }

  // Update Logic with incremental changes
  const runUpdate = (txChanges: TxKeyChanges | undefined) => {
    const { state, ops } = updateState(yDoc, yTx, yCheckpoint, clientId, clientState, txChanges)
    if (ops.length > 0) {
      notifySubscribers(state as State, ops)
    }
  }

  // Tx observer
  const txObserver = (event: Y.YMapEvent<TxRecord>, _transaction: Y.Transaction) => {
    const txChanges = extractTxChanges(event)
    runUpdate(txChanges)
  }

  // Checkpoint observer
  const checkpointObserver = (
    _event: Y.YMapEvent<CheckpointRecord>,
    _transaction: Y.Transaction
  ) => {
    runUpdate(emptyTxChanges)
  }

  yCheckpoint.observe(checkpointObserver)
  yTx.observe(txObserver)

  // Initial run (full recompute, treat as checkpoint change to initialize epoch cache)
  runUpdate(undefined)

  // Track disposal state
  let disposed = false

  const assertNotDisposed = () => {
    if (disposed) {
      failure("StateSyncLog has been disposed and cannot be used")
    }
  }

  const getActiveEpochInternal = () => {
    if (clientState.cachedFinalizedEpoch === null) {
      failure("cachedFinalizedEpoch is null - this should not happen after initialization")
    }
    return clientState.cachedFinalizedEpoch + 1
  }

  return {
    getState(): State {
      assertNotDisposed()
      return (clientState.cachedState ?? {}) as State
    },

    subscribe(callback: (newState: State, appliedOps: readonly Op[]) => void): () => void {
      assertNotDisposed()
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },

    emit(ops: Op[]): void {
      assertNotDisposed()
      yDoc.transact(() => {
        const activeEpoch = getActiveEpochInternal()
        appendTx(ops, yTx, activeEpoch, clientId, clientState)
      }, yjsOrigin)
    },

    reconcileState(targetState: State): void {
      assertNotDisposed()
      const currentState = (clientState.cachedState ?? {}) as State
      const ops = computeReconcileOps(currentState, targetState)
      if (ops.length > 0) {
        this.emit(ops)
      }
    },

    compact(): void {
      assertNotDisposed()
      yDoc.transact(() => {
        const activeEpoch = getActiveEpochInternal()
        const currentState = clientState.cachedState ?? {}
        createCheckpoint(yTx, yCheckpoint, clientState, activeEpoch, currentState, clientId)
      }, yjsOrigin)
    },

    dispose(): void {
      if (disposed) return // Already disposed, no-op
      disposed = true
      yTx.unobserve(txObserver)
      yCheckpoint.unobserve(checkpointObserver)
      subscribers.clear()
    },

    getActiveEpoch(): number {
      assertNotDisposed()
      return getActiveEpochInternal()
    },

    getActiveEpochTxCount(): number {
      assertNotDisposed()
      const activeEpoch = getActiveEpochInternal()
      let count = 0
      // Only current or future epochs exist in sortedTxs (past epochs are pruned during updateState).
      // Future epochs appear if we receive txs before the corresponding checkpoint.
      for (const entry of clientState.sortedTxs) {
        const ts = entry.txTimestamp
        if (ts.epoch === activeEpoch) {
          count++
        } else if (ts.epoch > activeEpoch) {
          break // Optimization: sorted order means we can stop early
        }
      }
      return count
    },

    getActiveEpochStartTime(): number | undefined {
      assertNotDisposed()
      const activeEpoch = getActiveEpochInternal()
      // Only current or future epochs exist in sortedTxs (past epochs are pruned during updateState).
      for (const entry of clientState.sortedTxs) {
        const ts = entry.txTimestamp
        if (ts.epoch === activeEpoch) {
          return ts.wallClock
        } else if (ts.epoch > activeEpoch) {
          break // Optimization: sorted order means we can stop early
        }
      }
      return undefined
    },

    isLogEmpty(): boolean {
      assertNotDisposed()
      return yTx.size === 0 && yCheckpoint.size === 0
    },

    [getSortedTxsSymbol](): SortedTxEntry[] {
      assertNotDisposed()
      return clientState.sortedTxs
    },
  }
}
