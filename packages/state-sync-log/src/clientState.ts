import type * as Y from "yjs"
import { CheckpointRecord } from "./checkpoints"
import { JSONObject } from "./json"
import { ValidateFn } from "./operations"
import { SortedTxEntry } from "./SortedTxEntry"
import { TxRecord } from "./TxRecord"
import { compareTxTimestamps, type TxTimestamp, type TxTimestampKey } from "./txTimestamp"

/**
 * Comparator for SortedTxEntry using cached timestamps.
 */
function compareSortedTxEntries(a: SortedTxEntry, b: SortedTxEntry): number {
  return compareTxTimestamps(a.txTimestamp, b.txTimestamp)
}

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

  // Sorted tx cache (ALL active/future txs, kept sorted).
  // Contains ONLY current (>= activeEpoch) or future txs.
  // Past epochs are physically pruned during syncLog and updateState.
  // Each entry caches its parsed timestamp and optionally the tx record.
  sortedTxs: SortedTxEntry[]
  sortedTxsMap: Map<TxTimestampKey, SortedTxEntry> // O(1) existence check and lookup

  // Applied dedup keys - tracks which LOGICAL txs have been applied.
  // This is the originalTxKey (or physical key if no original) for each applied tx.
  // Used by fast path to properly deduplicate re-emits.
  appliedTxKeys: Set<TxTimestampKey>

  // Track last applied timestamp for out-of-order detection
  lastAppliedTs: TxTimestamp | null

  // Track the index of the last applied transaction in sortedTxs (optimization)
  // -1 means nothing applied yet, reset on full recompute
  lastAppliedIndex: number

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
    sortedTxs: [],
    sortedTxsMap: new Map(),
    appliedTxKeys: new Set(),
    lastAppliedTs: null,
    lastAppliedIndex: -1,
    validateFn,
    retentionWindowMs,
  }
}

/**
 * Inserts a tx key into the sorted cache.
 * Also adds to the Map for O(1) existence checks.
 * Searches from the END since new txs typically have higher timestamps.
 * Returns true if insertion caused out-of-order (key before last applied).
 */
export function insertIntoSortedCache(
  clientState: ClientState,
  yTx: Y.Map<TxRecord>,
  key: TxTimestampKey
): boolean {
  const entry = new SortedTxEntry(key, yTx)
  const ts = entry.txTimestamp

  // Update max seen clock from all observed traffic
  if (ts.clock > clientState.maxSeenClock) {
    clientState.maxSeenClock = ts.clock
  }

  const sortedTxs = clientState.sortedTxs

  // Search from end (most common case: new tx has highest timestamp)
  for (let i = sortedTxs.length - 1; i >= 0; i--) {
    const existingTs = sortedTxs[i].txTimestamp
    if (compareTxTimestamps(ts, existingTs) >= 0) {
      // Insert after this position
      sortedTxs.splice(i + 1, 0, entry)
      clientState.sortedTxsMap.set(key, entry)

      // Check if this is out-of-order relative to last applied
      if (clientState.lastAppliedTs && compareTxTimestamps(ts, clientState.lastAppliedTs) < 0) {
        return true // Out of order!
      }
      return false
    }
  }

  // Lowest timestamp - insert at beginning
  sortedTxs.unshift(entry)
  clientState.sortedTxsMap.set(key, entry)

  // Check if this is out-of-order relative to last applied
  if (clientState.lastAppliedTs && compareTxTimestamps(ts, clientState.lastAppliedTs) < 0) {
    return true // Out of order!
  }
  return false
}

/**
 * Removes multiple tx keys from the sorted cache in a single pass.
 * Iterates from the start since old txs are typically deleted first.
 *
 * @returns The number of keys deleted.
 */
export function removeFromSortedCache(
  clientState: ClientState,
  keys: readonly TxTimestampKey[]
): number {
  if (keys.length === 0) return 0

  let deletedCount = 0

  // Build set of keys to delete (only those that exist in the map)
  const toDelete = new Set<TxTimestampKey>()
  for (const key of keys) {
    if (clientState.sortedTxsMap.has(key)) {
      clientState.sortedTxsMap.delete(key)
      toDelete.add(key)
    }
  }

  if (toDelete.size === 0) return 0

  // Single forward pass through sortedTxs, removing matching entries
  // Iterate from start since old txs (at beginning) are typically deleted first
  const sortedTxs = clientState.sortedTxs
  let i = 0
  while (i < sortedTxs.length && toDelete.size > 0) {
    if (toDelete.has(sortedTxs[i].txTimestampKey)) {
      toDelete.delete(sortedTxs[i].txTimestampKey)
      sortedTxs.splice(i, 1)
      deletedCount++
      // Don't increment i - next element shifted into current position
    } else {
      i++
    }
  }

  return deletedCount
}

/**
 * Rebuilds the sorted tx cache from all keys in yTx in O(n log n) time.
 * More efficient than calling insertIntoSortedCache n times (which is O(n²)).
 * Used during full recompute.
 */
export function rebuildSortedCache(clientState: ClientState, yTx: Y.Map<TxRecord>): void {
  // Clear existing cache
  clientState.sortedTxs = []
  clientState.sortedTxsMap.clear()

  // Collect all entries and pre-parse timestamps (O(n) parsing)
  const entries: SortedTxEntry[] = []
  let maxClock = clientState.maxSeenClock

  for (const key of yTx.keys()) {
    const entry = new SortedTxEntry(key, yTx)
    // Pre-parse and cache timestamp - avoids repeated parsing during sort
    const clock = entry.txTimestamp.clock
    if (clock > maxClock) {
      maxClock = clock
    }
    entries.push(entry)
  }
  clientState.maxSeenClock = maxClock

  // Sort once - O(n log n) comparisons, but timestamps already cached
  entries.sort(compareSortedTxEntries)

  // Build the map
  clientState.sortedTxs = entries
  for (const entry of entries) {
    clientState.sortedTxsMap.set(entry.txTimestampKey, entry)
  }
}
