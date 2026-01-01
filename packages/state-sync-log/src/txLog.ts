import * as Y from "yjs"
import { type CheckpointRecord, type ClientWatermarks, pruneCheckpoints } from "./checkpoints"
import { getFinalizedEpochAndCheckpoint } from "./checkpointUtils"
import { ClientState, insertIntoSortedCache, removeFromSortedCache } from "./clientState"
import { applyTxsImmutable } from "./draft"
import { JSONObject } from "./json"
import { Op } from "./operations"
import { computeReconcileOps } from "./reconcile"
import { SortedTxEntry } from "./SortedTxEntry"
import { TxRecord } from "./TxRecord"
import { type TxTimestamp, type TxTimestampKey, txTimestampToKey } from "./txTimestamp"

/**
 * Checks if a transaction is covered by the checkpoint watermarks.
 */
function isTransactionInCheckpoint(ts: TxTimestamp, watermarks: ClientWatermarks): boolean {
  const wm = watermarks[ts.clientId]
  if (!wm) return false
  return ts.clock <= wm.maxClock
}

/**
 * Changes to transaction keys from a Y.YMapEvent.
 * - added: keys that were added
 * - deleted: keys that were deleted
 */
export type TxKeyChanges = {
  added: readonly TxTimestampKey[]
  deleted: readonly TxTimestampKey[]
}

/**
 * Appends a new transaction to the log.
 *
 * @param originalKey - Optional reference to the original transaction key for re-emits.
 *                      Used by syncLog to preserve transactions missed by checkpoints.
 */
export function appendTx(
  ops: readonly Op[],
  yTx: Y.Map<TxRecord>,
  activeEpoch: number,
  myClientId: string,
  clientState: ClientState,
  originalKey?: TxTimestampKey
): TxTimestampKey {
  // 1. Advance logical clock (Lamport) based on all seen traffic
  const clock = Math.max(clientState.localClock, clientState.maxSeenClock) + 1
  clientState.localClock = clock

  // 2. Generate Key with WallClock for future pruning safety
  const ts: TxTimestamp = {
    epoch: activeEpoch,
    clock,
    clientId: myClientId,
    wallClock: Date.now(),
  }
  const key = txTimestampToKey(ts)

  // 3. Write to Yjs (Atomic)
  const record: TxRecord = originalKey ? { ops, originalTxKey: originalKey } : { ops }
  yTx.set(key, record)

  return key
}

/**
 * Synchronizes the transaction log with the current checkpoint.
 * Re-emits missed transactions and prunes old ones.
 *
 * Should be called BEFORE updateState to ensure log is clean and complete.
 *
 * @returns true if any transactions were re-emitted or deleted, which may invalidate lastAppliedIndex
 */
function syncLog(
  yTx: Y.Map<TxRecord>,
  myClientId: string,
  clientState: ClientState,
  finalizedEpoch: number,
  baseCP: CheckpointRecord | null,
  newKeys?: readonly TxTimestampKey[] // keys added in this update
): boolean {
  const activeEpoch = finalizedEpoch + 1
  const watermarks = baseCP?.watermarks ?? {}

  // Deterministic Reference Time: Use stored minWallClock if available, otherwise 0 (nothing ancient).
  const referenceTime = baseCP?.minWallClock ?? 0

  // Helper to check if a transaction should be pruned
  const shouldPrune = (ts: TxTimestamp, dedupTs: TxTimestamp): boolean => {
    const isAncient = referenceTime - ts.wallClock > clientState.retentionWindowMs
    if (isAncient) return true
    return isTransactionInCheckpoint(dedupTs, watermarks)
  }

  const toDelete: TxTimestampKey[] = []
  const toReEmit: Array<{ originalKey: TxTimestampKey; tx: TxRecord }> = []

  // 1. Helper to decide what to do with each transaction
  const processEntry = (entry: SortedTxEntry): boolean => {
    if (shouldPrune(entry.txTimestamp, entry.dedupTxTimestamp)) {
      toDelete.push(entry.txTimestampKey)
      return false // deleted
    }

    if (entry.txTimestamp.epoch <= finalizedEpoch) {
      // Not in checkpoint and still fresh - re-emit it to the active epoch
      toReEmit.push({ originalKey: entry.dedupTxTimestampKey, tx: entry.txRecord })
      toDelete.push(entry.txTimestampKey)
      return false // re-emitted
    }

    return true // active/fresh
  }

  // 2. Scan local cache (sortedTxs) to identify missing/ancient transactions
  for (const entry of clientState.sortedTxs) {
    if (processEntry(entry)) {
      // Optimization: Physical keys are sorted. If we hit the active/fresh territory, we can stop.
      break
    }
  }

  const processKeyByTimestampKey = (txTimestampKey: TxTimestampKey): void => {
    // Only process if it actually exists in Yjs Map
    if (yTx.has(txTimestampKey)) {
      processEntry(new SortedTxEntry(txTimestampKey, yTx))
    }
  }

  // 3. Scan NEW keys from Yjs to handle incoming transactions (sync)
  // Any client can re-emit - deduplication via originalTxKey handles duplicates.
  if (newKeys) {
    for (const key of newKeys) {
      processKeyByTimestampKey(key)
    }
  }

  // 4. Re-emit missed transactions BEFORE pruning
  for (const { originalKey, tx } of toReEmit) {
    const newKey = appendTx(tx.ops, yTx, activeEpoch, myClientId, clientState, originalKey)
    insertIntoSortedCache(clientState, yTx, newKey)
  }

  // 5. Prune old/finalized/redundant transactions from Yjs Map
  for (const key of toDelete) {
    yTx.delete(key)
  }
  removeFromSortedCache(clientState, toDelete)

  // Return true if any changes were made that may invalidate lastAppliedIndex
  return toReEmit.length > 0 || toDelete.length > 0
}

/**
 * Internal helper to apply all transactions from the sorted cache to compute state.
 * This is the core replay loop used by both full recompute and out-of-order replay.
 * Uses COW (copy-on-write) draft system for efficient immutable updates.
 */
function applyAllTransactions(clientState: ClientState, baseState: JSONObject): JSONObject {
  const baseCP = clientState.currentBaseCheckpoint

  clientState.appliedTxKeys.clear()

  // Check if transaction was already applied in the base checkpoint
  const watermarks = baseCP?.watermarks ?? {}
  let hasWatermarks = false
  for (const _ in watermarks) {
    hasWatermarks = true
    break
  }

  const sortedTxs = clientState.sortedTxs
  const appliedTxKeys = clientState.appliedTxKeys
  const validateFn = clientState.validateFn

  // Collect transactions to apply (filtered by dedup and watermarks)
  const txsToApply: { ops: readonly Op[] }[] = []
  for (let i = 0, len = sortedTxs.length; i < len; i++) {
    const entry = sortedTxs[i]
    const dedupKey = entry.dedupTxTimestampKey

    if (appliedTxKeys.has(dedupKey)) {
      continue
    }

    appliedTxKeys.add(dedupKey)

    if (hasWatermarks) {
      const dedupTs = entry.dedupTxTimestamp
      if (isTransactionInCheckpoint(dedupTs, watermarks)) {
        continue
      }
    }

    txsToApply.push({ ops: entry.txRecord.ops })
  }

  // Set lastAppliedTs and lastAppliedIndex
  if (sortedTxs.length > 0) {
    clientState.lastAppliedTs = sortedTxs[sortedTxs.length - 1].txTimestamp
    clientState.lastAppliedIndex = sortedTxs.length - 1
  } else {
    clientState.lastAppliedIndex = -1
  }

  if (txsToApply.length === 0) {
    return baseState
  }

  // Use custom draft system for copy-on-write immutable updates
  // Apply all txs using a shared draft context for performance
  return applyTxsImmutable(baseState, txsToApply, validateFn)
}

/**
 * Internal helper to recompute state from transactions.
 * Assumes the sorted cache is already up-to-date.
 */
function recomputeState(clientState: ClientState): { state: JSONObject; ops: Op[] } {
  const oldState = clientState.cachedState ?? {}

  clientState.lastAppliedTs = null
  clientState.lastAppliedIndex = -1

  // Get base state from checkpoint (draft system handles structural sharing)
  const baseCP = clientState.currentBaseCheckpoint
  const baseState: JSONObject = baseCP ? baseCP.state : {}

  // Apply all transactions
  const newState = applyAllTransactions(clientState, baseState)
  clientState.cachedState = newState

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

  // Track if we need to rebuild sorted cache (first run or checkpoint changed)
  const needsRebuildSortedCache =
    clientState.cachedState === null || canonicalCheckpointChanged || !txChanges
  // Rebuild sorted cache before syncLog if needed
  if (needsRebuildSortedCache) {
    clientState.sortedTxs = []
    clientState.sortedTxsMap.clear()
    for (const key of yTx.keys()) {
      insertIntoSortedCache(clientState, yTx, key)
    }
  }

  // Sync and prune within transaction
  let syncLogModifiedCache = false
  doc.transact(() => {
    syncLogModifiedCache = syncLog(
      yTx,
      myClientId,
      clientState,
      finalizedEpoch,
      baseCP,
      txChanges?.added
    )

    // Safe to use local finalizedEpoch here
    pruneCheckpoints(yCheckpoint, finalizedEpoch)
  })

  // Update sorted cache with new/deleted keys from txChanges
  // This must happen after syncLog which may have deleted some of these keys
  // Track out-of-order insertions for fast path
  let earlyOutOfOrder = false
  if (txChanges) {
    // Process deleted keys (syncLog may have deleted more than txChanges.deleted)
    // The Map was already updated by removeFromSortedCache in syncLog

    // Process added keys
    for (const key of txChanges.added) {
      // CRITICAL: Check yTx.has(key)! syncLog might have just pruned it.
      if (yTx.has(key) && !clientState.sortedTxsMap.has(key)) {
        if (insertIntoSortedCache(clientState, yTx, key)) {
          earlyOutOfOrder = true
        }
      }
    }
  }

  if (needsRebuildSortedCache) {
    // SLOW PATH: Full recompute
    return recomputeState(clientState)
  }

  // SEMI FAST PATH: Incremental update using only changed keys

  // Process deleted keys first
  const deletedCount = removeFromSortedCache(clientState, txChanges.deleted)

  // If any keys were deleted from yTx, we need to recompute state.
  // This is because the deleted transactions might have been applied before,
  // and we can't incrementally "unapply" them - we need a full replay.
  const hasDeletedTx = deletedCount > 0

  // syncLog may have deleted/re-emitted transactions, invalidating lastAppliedIndex
  // Also check for out-of-order insertions from early insert loop
  // Also trigger recompute if transactions were deleted from yTx
  const outOfOrder = earlyOutOfOrder || syncLogModifiedCache || hasDeletedTx

  // NOTE: Added keys are already in cache from early insert above
  // The early insert loop handles all txChanges.added keys before we reach this point

  // Out-of-order arrival detected - use optimized replay (reuses sorted cache)
  if (outOfOrder) {
    return recomputeState(clientState)
  }

  // FAST PATH: Updates that are added in-order at the end of the log

  // Apply pending transactions - O(1) optimization: start from lastAppliedIndex + 1
  let state = clientState.cachedState as JSONObject
  const appliedOps: Op[] = []
  let lastAppliedEntry: SortedTxEntry | null = null
  const sortedTxs = clientState.sortedTxs
  const startIndex = clientState.lastAppliedIndex + 1

  for (let i = startIndex; i < sortedTxs.length; i++) {
    const entry = sortedTxs[i]

    const dedupKey = entry.dedupTxTimestampKey

    // Skip if already applied (deduplication) - handles re-emits with same originalTxKey
    if (clientState.appliedTxKeys.has(dedupKey)) {
      continue
    }

    const tx = entry.txRecord

    // Use custom draft system for copy-on-write
    // applyTxsImmutable returns the original state if validation fails
    const newState = applyTxsImmutable(state, [tx], clientState.validateFn)
    if (newState !== state) {
      state = newState
      appliedOps.push(...tx.ops)
    }

    clientState.appliedTxKeys.add(dedupKey)
    lastAppliedEntry = entry
    clientState.lastAppliedIndex = i
  }

  // Use cached timestamp from the last applied entry
  if (lastAppliedEntry) {
    clientState.lastAppliedTs = lastAppliedEntry.txTimestamp
  }

  clientState.cachedState = state

  return { state, ops: appliedOps }
}
