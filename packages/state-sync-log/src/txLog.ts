import * as Y from "yjs"
import { type CheckpointRecord, type ClientWatermarks, pruneCheckpoints } from "./checkpoints"
import { getFinalizedEpochAndCheckpoint } from "./checkpointUtils"
import { ClientState, insertIntoSortedCache, removeFromSortedCache } from "./clientState"
import { JSONObject } from "./json"

import { applyTx, Op } from "./operations"

import { computeReconcileOps } from "./reconcile"
import { SortedTxEntry } from "./SortedTxEntry"
import { TxRecord } from "./TxRecord"
import {
  parseTxTimestampKey,
  type TxTimestamp,
  type TxTimestampKey,
  txTimestampToKey,
} from "./txTimestamp"

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
 */
function syncLog(
  yTx: Y.Map<TxRecord>,
  myClientId: string,
  clientState: ClientState,
  finalizedEpoch: number,
  baseCP: CheckpointRecord | null,
  newKeys?: readonly TxTimestampKey[] // keys added in this update
): void {
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
  const processKey = (
    txTimestampKey: TxTimestampKey,
    txTimestamp: TxTimestamp,
    txOriginalTimestampKey: TxTimestampKey | undefined | null,
    txOriginalTimestamp: TxTimestamp | undefined | null,
    txRecord: TxRecord
  ): boolean => {
    const dedupTs = txOriginalTimestamp ?? txTimestamp

    if (shouldPrune(txTimestamp, dedupTs)) {
      toDelete.push(txTimestampKey)
      return false // deleted
    }

    if (txTimestamp.epoch <= finalizedEpoch) {
      // Not in checkpoint and still fresh - re-emit it to the active epoch
      toReEmit.push({ originalKey: txOriginalTimestampKey ?? txTimestampKey, tx: txRecord })
      toDelete.push(txTimestampKey)
      return false // re-emitted
    }

    return true // active/fresh
  }

  // 2. Scan local cache (sortedTxs) to identify missing/ancient transactions
  for (const entry of clientState.sortedTxs) {
    if (
      processKey(
        entry.txTimestampKey,
        entry.txTimestamp,
        entry.originalTxTimestampKey,
        entry.originalTxTimestamp,
        entry.txRecord
      )
    ) {
      // Optimization: Physical keys are sorted. If we hit the active/fresh territory, we can stop.
      break
    }
  }

  const processKeyByTimestampKey = (txTimestampKey: TxTimestampKey): void => {
    const txRecord = yTx.get(txTimestampKey)
    if (!txRecord) return

    processKey(
      txTimestampKey,
      parseTxTimestampKey(txTimestampKey),
      txRecord.originalTxKey,
      txRecord.originalTxKey ? parseTxTimestampKey(txRecord.originalTxKey) : undefined,
      txRecord
    )
  }

  // 3. Scan NEW keys from Yjs to handle incoming transactions (sync)
  // Any client can re-emit - deduplication via originalTxKey handles duplicates.
  if (newKeys) {
    for (const key of newKeys) {
      processKeyByTimestampKey(key)
    }
  }

  // 3. Re-emit missed transactions BEFORE pruning
  for (const { originalKey, tx } of toReEmit) {
    const newKey = appendTx(tx.ops, yTx, activeEpoch, myClientId, clientState, originalKey)
    insertIntoSortedCache(clientState, yTx, newKey)
  }

  // 4. Prune old/finalized/redundant transactions from Yjs Map
  for (const key of toDelete) {
    yTx.delete(key)
  }
  removeFromSortedCache(clientState, toDelete)
}

/**
 * Internal helper to compute current state from the log (full recompute).
 * Uses cached finalized epoch and checkpoint from clientState.
 * Also populates appliedTxKeys with all dedupKeys.
 */
function computeState(yTx: Y.Map<TxRecord>, clientState: ClientState): JSONObject {
  const baseCP = clientState.currentBaseCheckpoint
  let state: JSONObject = baseCP ? structuredClone(baseCP.state) : {}

  clientState.sortedTxs = []
  clientState.sortedTxsMap.clear()
  clientState.appliedTxKeys.clear()

  for (const key of yTx.keys()) {
    insertIntoSortedCache(clientState, yTx, key)
  }

  // Check if transaction was already applied in the base checkpoint
  const watermarks = baseCP?.watermarks ?? {}
  // Fast check for non-empty object (avoids Object.keys allocation)
  let hasWatermarks = false
  for (const _ in watermarks) {
    hasWatermarks = true
    break
  }

  for (const entry of clientState.sortedTxs) {
    const dedupKey = entry.originalTxTimestampKey ?? entry.txTimestampKey

    // Skip if already processed (handles duplicates within this loop)
    if (clientState.appliedTxKeys.has(dedupKey)) {
      continue
    }

    // Mark as processed for fast path deduplication
    clientState.appliedTxKeys.add(dedupKey)

    // Skip if this dedupKey was already applied in the checkpoint
    // Only parse timestamp if we have watermarks to check against
    if (hasWatermarks) {
      const dedupTs = entry.originalTxTimestamp ?? entry.txTimestamp
      if (isTransactionInCheckpoint(dedupTs, watermarks)) {
        continue
      }
    }

    const newState = applyTx(
      state,
      entry.txRecord.ops,
      clientState.validateFn,
      clientState.immutable
    )
    if (newState) {
      state = newState
    }
  }

  // Set lastAppliedTs to the last entry if we have any
  if (clientState.sortedTxs.length > 0) {
    clientState.lastAppliedTs = clientState.sortedTxs[clientState.sortedTxs.length - 1].txTimestamp
  }

  return state
}

/**
 * Internal helper to compute full state and update cache.
 */
function computeFullState(yTx: Y.Map<TxRecord>, clientState: ClientState): JSONObject {
  const state = computeState(yTx, clientState)
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
  clientState.sortedTxs = []
  clientState.sortedTxsMap.clear()
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
  txChanges: TxKeyChanges | undefined,
  immutable = false
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

  // FIRST RUN: Populate sortedTxs immediately if cache is empty
  // This allows syncLog to use the optimized O(1) sorted path even on first load.
  if (clientState.cachedState === null) {
    clientState.sortedTxs = []
    clientState.sortedTxsMap.clear()
    for (const key of yTx.keys()) {
      insertIntoSortedCache(clientState, yTx, key)
    }
  }

  // Sync and prune within transaction
  doc.transact(() => {
    syncLog(yTx, myClientId, clientState, finalizedEpoch, baseCP, txChanges?.added)
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
  removeFromSortedCache(clientState, txChanges.deleted)

  // Process added keys
  for (const key of txChanges.added) {
    // CRITICAL: Check yTx.has(key)! syncLog might have just pruned it.
    if (yTx.has(key) && !clientState.sortedTxsMap.has(key)) {
      if (insertIntoSortedCache(clientState, yTx, key)) {
        outOfOrder = true
      }
    }
  }

  // Out-of-order arrival detected - need full replay
  if (outOfOrder) {
    return handleFullRecompute(yTx, clientState)
  }

  // Apply pending transactions
  let state = clientState.cachedState as JSONObject
  const appliedOps: Op[] = []
  let lastAppliedEntry: SortedTxEntry | null = null

  for (const entry of clientState.sortedTxs) {
    // Fast path: for transactions without originalTxKey, key === dedupKey
    // So this check catches most already-applied transactions
    if (clientState.appliedTxKeys.has(entry.txTimestampKey)) continue

    const tx = entry.txRecord
    if (!tx) continue

    const dedupKey = tx.originalTxKey ?? entry.txTimestampKey

    // Skip if already applied (deduplication) - handles re-emits
    if (clientState.appliedTxKeys.has(dedupKey)) {
      continue
    }

    const newState = applyTx(state, tx.ops, clientState.validateFn, immutable)
    if (newState) {
      state = newState
      appliedOps.push(...tx.ops)
    }

    clientState.appliedTxKeys.add(dedupKey)
    lastAppliedEntry = entry
  }

  // Use cached timestamp from the last applied entry
  if (lastAppliedEntry) {
    clientState.lastAppliedTs = lastAppliedEntry.txTimestamp
  }

  clientState.cachedState = state
  return { state, ops: appliedOps }
}
