import * as Y from "yjs"
import { type CheckpointRecord, pruneCheckpoints } from "./checkpoints"
import { getFinalizedEpochAndCheckpoint, isTransactionInCheckpoint } from "./checkpointUtils"
import { ClientState, insertIntoSortedCache, removeFromSortedCache } from "./clientState"
import { JSONObject } from "./json"

import { applyTransaction, Op } from "./operations"

import { computeReconcileOps } from "./reconcile"
import {
  parseTransactionTimestampKey,
  type TransactionTimestamp,
  type TransactionTimestampKey,
  transactionTimestampToKey,
} from "./transactionTimestamp"

/**
 * The immutable record stored in the Log.
 */
export type TxRecord = {
  ops: Op[]
  /**
   * If this is a re-emit of a missed transaction, this field holds the
   * ORIGINAL key. Used for deduplication to prevent applying the same logical
   * action twice.
   */
  originalTxKey?: TransactionTimestampKey
}

/**
 * Changes to transaction keys from a Y.YMapEvent.
 * - added: keys that were added
 * - deleted: keys that were deleted
 */
export type TxKeyChanges = {
  added: readonly TransactionTimestampKey[]
  deleted: readonly TransactionTimestampKey[]
}

/**
 * Appends a new transaction to the log.
 *
 * @param originalKey - Optional reference to the original transaction key for re-emits.
 *                      Used by syncLog to preserve transactions missed by checkpoints.
 */
export function appendTransaction(
  ops: Op[],
  yTx: Y.Map<TxRecord>,
  activeEpoch: number,
  myClientId: string,
  clientState: ClientState,
  originalKey?: TransactionTimestampKey
): void {
  // 1. Advance logical clock (Lamport) based on all seen traffic
  const clock = Math.max(clientState.localClock, clientState.maxSeenClock) + 1
  clientState.localClock = clock

  // 2. Generate Key with WallClock for future pruning safety
  const ts: TransactionTimestamp = {
    epoch: activeEpoch,
    clock,
    clientId: myClientId,
    wallClock: Date.now(),
  }
  const key = transactionTimestampToKey(ts)

  // 3. Write to Yjs (Atomic)
  const record: TxRecord = originalKey ? { ops, originalTxKey: originalKey } : { ops }
  yTx.set(key, record)
}

/**
 * Synchronizes the transaction log with the current checkpoint.
 * Re-emits missed transactions and prunes old ones.
 *
 * Should be called BEFORE updateState to ensure log is clean and complete.
 */
function syncLog(
  yTx: Y.Map<TxRecord>,
  myClientId: string,
  clientState: ClientState,
  finalizedEpoch: number,
  baseCP: CheckpointRecord | null
): void {
  const activeEpoch = finalizedEpoch + 1
  const watermarks = baseCP?.watermarks ?? {}

  // Deterministic Reference Time: Use stored minWallClock if available, otherwise 0 (nothing ancient).
  const referenceTime = baseCP?.minWallClock ?? 0

  const toDelete: TransactionTimestampKey[] = []
  const toReEmit: Array<{ originalKey: TransactionTimestampKey; tx: TxRecord }> = []

  // Single pass through all transactions
  for (const [key, tx] of yTx.entries()) {
    const ts = parseTransactionTimestampKey(key)

    // Handle finalized epoch transactions
    if (ts.epoch <= finalizedEpoch) {
      toDelete.push(key)

      // Only re-emit if:
      // 1. Not in checkpoint watermarks (missed)
      // 2. Not ancient (within retention window)
      const isAncient = referenceTime - ts.wallClock > clientState.retentionWindowMs
      if (!isTransactionInCheckpoint(key, watermarks) && !isAncient) {
        // Missed by checkpoint and still fresh - re-emit it
        toReEmit.push({ originalKey: key, tx })
      }
    }

    // Handle redundant re-emits in active epoch
    if (tx.originalTxKey && isTransactionInCheckpoint(tx.originalTxKey, watermarks)) {
      toDelete.push(key)
    }
  }

  // Re-emit missed transactions BEFORE pruning
  for (const { originalKey, tx } of toReEmit) {
    appendTransaction(tx.ops, yTx, activeEpoch, myClientId, clientState, originalKey)
  }

  // Prune old/finalized transactions
  for (const key of toDelete) {
    yTx.delete(key)
  }
}

/**
 * Internal helper to compute current state from the log (full recompute).
 * Uses cached finalized epoch and checkpoint from clientState.
 */
function computeState(yTx: Y.Map<TxRecord>, clientState: ClientState): JSONObject {
  const baseCP = clientState.currentBaseCheckpoint
  let state: JSONObject = baseCP ? structuredClone(baseCP.state) : {}

  clientState.sortedTxKeys = []
  clientState.sortedTxKeysSet.clear()

  for (const key of yTx.keys()) {
    insertIntoSortedCache(clientState, key)
  }

  const localSeen = new Set<string>()

  for (const key of clientState.sortedTxKeys) {
    const tx = yTx.get(key)
    if (!tx) continue

    const dedupKey = tx.originalTxKey ?? key
    if (localSeen.has(dedupKey)) continue

    localSeen.add(dedupKey)
    const newState = applyTransaction(state, tx.ops, clientState.validateFn)
    if (newState !== state) {
      state = newState
    }

    clientState.lastAppliedTs = parseTransactionTimestampKey(key)
  }

  return state
}

/**
 * Internal helper to compute full state and update cache.
 */
function computeFullState(yTx: Y.Map<TxRecord>, clientState: ClientState): JSONObject {
  const state = computeState(yTx, clientState)

  clientState.appliedTxKeys.clear()
  for (const key of clientState.sortedTxKeys) {
    clientState.appliedTxKeys.add(key)
  }
  clientState.sortedTxKeys = []
  clientState.sortedTxKeysSet.clear()

  clientState.cachedState = state
  return state
}

/**
 * Internal helper to perform a full recompute and return the state and reconciliation ops.
 */
function handleFullRecompute(
  yTx: Y.Map<TxRecord>,
  clientState: ClientState
): { state: JSONObject; ops: Op[] } {
  const oldState = clientState.cachedState ?? {}
  clientState.sortedTxKeys = []
  clientState.sortedTxKeysSet.clear()
  clientState.lastAppliedTs = null
  const newState = computeFullState(yTx, clientState)
  const ops = computeReconcileOps(oldState, newState)
  return { state: newState, ops }
}

/**
 * The primary update function that maintains current state.
 *
 * @param txChanges - Changes from Y.YMapEvent. If undefined (first run), performs a full scan.
 */
export function updateState(
  doc: Y.Doc,
  yTx: Y.Map<TxRecord>,
  yCheckpoint: Y.Map<CheckpointRecord>,
  myClientId: string,
  clientState: ClientState,
  txChanges: TxKeyChanges | undefined
): { state: JSONObject; ops: Op[] } {
  // Always calculate fresh finalized epoch and checkpoint to handle sync race conditions
  const { finalizedEpoch, checkpoint: baseCP } = getFinalizedEpochAndCheckpoint(yCheckpoint)

  // Determine if canonical checkpoint changed from what we have cached
  const oldFinalizedEpoch = clientState.cachedFinalizedEpoch
  const oldCP = clientState.currentBaseCheckpoint

  const epochChanged = finalizedEpoch !== (oldFinalizedEpoch ?? -1)
  const txCountChanged = (baseCP?.txCount ?? -1) !== (oldCP?.txCount ?? -1)
  const nullityChanged = (baseCP === null) !== (oldCP === null)

  const canonicalCheckpointChanged = epochChanged || txCountChanged || nullityChanged

  // Update read-cache
  clientState.cachedFinalizedEpoch = finalizedEpoch
  clientState.currentBaseCheckpoint = baseCP

  // Sync and prune within transaction
  doc.transact(() => {
    syncLog(yTx, myClientId, clientState, finalizedEpoch, baseCP)
    // Safe to use local finalizedEpoch here
    pruneCheckpoints(yCheckpoint, finalizedEpoch)
  })

  // Full recompute needed if:
  // - First run (no cached state)
  // - Canonical checkpoint changed
  // - No txChanges provided (fallback to full scan)
  const needsFullRecompute =
    clientState.cachedState === null || canonicalCheckpointChanged || !txChanges

  if (needsFullRecompute) {
    return handleFullRecompute(yTx, clientState)
  }

  // FAST PATH: Incremental update using only changed keys
  let outOfOrder = false

  // Process deleted keys
  for (const key of txChanges.deleted) {
    if (clientState.sortedTxKeysSet.has(key)) {
      removeFromSortedCache(clientState, key)
    }
    // Also remove from applied if it was there
    clientState.appliedTxKeys.delete(key)
  }

  // Process added keys
  for (const key of txChanges.added) {
    if (!clientState.appliedTxKeys.has(key) && !clientState.sortedTxKeysSet.has(key)) {
      if (insertIntoSortedCache(clientState, key)) {
        outOfOrder = true
      }
    }
  }

  // Out-of-order arrival detected - need full replay
  if (outOfOrder) {
    return handleFullRecompute(yTx, clientState)
  }

  // Apply all pending transactions (they're already sorted)
  let state = clientState.cachedState as JSONObject
  const localSeen = new Set<string>()
  const toApply = [...clientState.sortedTxKeys]
  const appliedOps: Op[] = []

  for (const key of toApply) {
    const tx = yTx.get(key)
    if (!tx) continue

    const dedupKey = tx.originalTxKey ?? key
    if (localSeen.has(dedupKey)) {
      removeFromSortedCache(clientState, key)
      continue
    }
    localSeen.add(dedupKey)

    const newState = applyTransaction(state, tx.ops, clientState.validateFn)
    if (newState !== state) {
      state = newState
      appliedOps.push(...tx.ops)
    }

    removeFromSortedCache(clientState, key)
    clientState.appliedTxKeys.add(key)
    clientState.lastAppliedTs = parseTransactionTimestampKey(key)
  }

  clientState.cachedState = state
  return { state, ops: appliedOps }
}
