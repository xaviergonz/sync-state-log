import { CheckpointRecord } from "./checkpoints"
import { JSONObject } from "./json"
import { ValidateFn } from "./operations"
import {
  compareTransactionTimestamps,
  parseTransactionTimestampKey,
  type TransactionTimestamp,
  type TransactionTimestampKey,
} from "./transactionTimestamp"

/**
 * Client-side state including clocks and cache for incremental updates
 */
export interface ClientState {
  // Lamport clocks (monotonic, never reset)
  localClock: number
  maxSeenClock: number

  // Incremental update cache
  cachedState: JSONObject | null
  currentBaseCheckpoint: CheckpointRecord | null

  // Cached finalized epoch (null = not yet initialized, recalculated only when checkpoint map changes)
  cachedFinalizedEpoch: number | null

  // Sorted transaction cache (ALL active/future transactions, kept sorted).
  // Contains ONLY current (>= activeEpoch) or future transactions.
  // Past epochs are physically pruned during syncLog and updateState.
  sortedTxKeys: TransactionTimestampKey[]
  sortedTxKeysSet: Set<TransactionTimestampKey> // O(1) existence check

  // Applied transactions (subset of sortedTxKeys).
  // Tracks which physical transactions have already been integrated into the current `cachedState`.
  // - Enables incremental updates by identifying truly new transactions (Fast Path).
  // - Enables deduplication against logical duplicates (re-emits) from previous updates.
  appliedTxKeys: Set<TransactionTimestampKey>

  // Track last applied timestamp for out-of-order detection
  lastAppliedTs: TransactionTimestamp | null

  // Validation function (optional, defaults to always true)
  validateFn?: ValidateFn<JSONObject>

  /**
   * Timestamp retention window in milliseconds.
   */
  retentionWindowMs: number
}

/**
 * Factory to create an initial ClientState
 */
export function createClientState(
  validateFn: ValidateFn<JSONObject> | undefined,
  retentionWindowMs: number
): ClientState {
  return {
    localClock: 0,
    maxSeenClock: 0,
    cachedState: null,
    currentBaseCheckpoint: null,
    cachedFinalizedEpoch: null, // Will be recalculated on first run
    sortedTxKeys: [],
    sortedTxKeysSet: new Set(),
    appliedTxKeys: new Set(),
    lastAppliedTs: null,
    validateFn,
    retentionWindowMs,
  }
}

/**
 * Inserts a transaction key into the sorted cache.
 * Also adds to the Set for O(1) existence checks.
 * Searches from the END since new transactions typically have higher timestamps.
 * Returns true if insertion caused out-of-order (key before last applied).
 */
export function insertIntoSortedCache(
  clientState: ClientState,
  key: TransactionTimestampKey
): boolean {
  const ts = parseTransactionTimestampKey(key)

  // Update max seen clock from all observed traffic
  if (ts.clock > clientState.maxSeenClock) {
    clientState.maxSeenClock = ts.clock
  }

  const sortedKeys = clientState.sortedTxKeys

  // Search from end (most common case: new tx has highest timestamp)
  for (let i = sortedKeys.length - 1; i >= 0; i--) {
    const existingTs = parseTransactionTimestampKey(sortedKeys[i])
    if (compareTransactionTimestamps(ts, existingTs) >= 0) {
      // Insert after this position
      sortedKeys.splice(i + 1, 0, key)
      clientState.sortedTxKeysSet.add(key)

      // Check if this is out-of-order relative to last applied
      if (
        clientState.lastAppliedTs &&
        compareTransactionTimestamps(ts, clientState.lastAppliedTs) < 0
      ) {
        return true // Out of order!
      }
      return false
    }
  }

  // Lowest timestamp - insert at beginning
  sortedKeys.unshift(key)
  clientState.sortedTxKeysSet.add(key)

  // Check if this is out-of-order relative to last applied
  if (
    clientState.lastAppliedTs &&
    compareTransactionTimestamps(ts, clientState.lastAppliedTs) < 0
  ) {
    return true // Out of order!
  }
  return false
}

/**
 * Removes a transaction key from the sorted cache.
 * Searches from the START since old transactions are removed first.
 */
export function removeFromSortedCache(
  clientState: ClientState,
  key: TransactionTimestampKey
): void {
  clientState.sortedTxKeysSet.delete(key)
  // DO NOT remove from applied here. Managed by updateState.

  // Search from start (most common case: oldest tx being removed)
  for (let i = 0; i < clientState.sortedTxKeys.length; i++) {
    if (clientState.sortedTxKeys[i] === key) {
      clientState.sortedTxKeys.splice(i, 1)
      return
    }
  }
}
