import * as Y from "yjs"
import { ClientId } from "./ClientId"
import { getFinalizedEpochAndCheckpoint } from "./checkpointUtils"
import { failure } from "./error"
import { JSONObject } from "./json"
import { type TxRecord } from "./transactionLog"
import {
  parseTransactionTimestampKey,
  type TransactionTimestamp,
  type TransactionTimestampKey,
} from "./transactionTimestamp"

/**
 * Watermarking for deduplication and pruning.
 * - maxClock: All txs from this client with clock <= maxClock are FINALIZED.
 * - maxWallClock: The last time we saw this client active (for pruning).
 */
type ClientWatermark = Readonly<{
  maxClock: number
  maxWallClock: number
}>

/**
 * Watermarks for all clients.
 */
export type ClientWatermarks = Record<ClientId, ClientWatermark>

/**
 * A snapshot of the state at the end of a specific epoch.
 */
export type CheckpointRecord = {
  state: JSONObject // The document state
  watermarks: ClientWatermarks // Dedup/Pruning info
  txCount: number // Tie-breaker for canonical selection
  minWallClock: number // Reference time for this epoch (deterministic pruning)
}

/**
 * Unique ID for a checkpoint.
 * Format: `${epoch};${txCount};${clientId}`
 */
export type CheckpointKey = string

/**
 * Data extracted from a checkpoint key.
 */
export type CheckpointKeyData = {
  epoch: number
  txCount: number
  clientId: ClientId
}

/**
 * Converts checkpoint key data components to a key string.
 */
export function checkpointKeyToKey(data: CheckpointKeyData): CheckpointKey {
  return `${data.epoch};${data.txCount};${data.clientId}`
}

/**
 * Helper to parse checkpoint keys.
 * Checkpoint keys have format: `${epoch};${txCount};${clientId}`
 * Throws if key is malformed.
 */
export function parseCheckpointKey(key: CheckpointKey): CheckpointKeyData {
  const i1 = key.indexOf(";")
  const i2 = key.indexOf(";", i1 + 1)

  if (i1 === -1 || i2 === -1) {
    failure(`Malformed checkpoint key: ${key}`)
  }

  return {
    epoch: Number.parseInt(key.substring(0, i1), 10),
    txCount: Number.parseInt(key.substring(i1 + 1, i2), 10),
    clientId: key.substring(i2 + 1),
  }
}

/**
 * Called periodically (e.g. by a server or leader client) to finalize the epoch.
 */
export function createCheckpoint(
  yTx: Y.Map<TxRecord>,
  yCheckpoint: Y.Map<CheckpointRecord>,
  activeEpoch: number,
  currentState: JSONObject,
  myClientId: string,
  retentionWindowMs: number
): void {
  // 1. Start with previous watermarks (from finalized epoch = activeEpoch - 1)
  const { checkpoint: prevCP } = getFinalizedEpochAndCheckpoint(yCheckpoint)
  const newWatermarks = prevCP ? { ...prevCP.watermarks } : {}

  // Get active transactions using cached sorted order (filter by epoch)
  // FILTER IS REQUIRED:
  // Although we are finalizing 'activeEpoch', other peers may have already
  // advanced to the next epoch and started syncing those transactions.
  // We must ensure this checkpoint ONLY contains transactions from 'activeEpoch'.
  const activeTxs: Array<{ key: TransactionTimestampKey; tx: TxRecord; ts: TransactionTimestamp }> =
    []
  for (const key of yTx.keys()) {
    const ts = parseTransactionTimestampKey(key)
    if (ts.epoch === activeEpoch) {
      const tx = yTx.get(key)
      if (tx) {
        activeTxs.push({ key, tx, ts })
      }
    }
  }

  if (activeTxs.length === 0) {
    return // Do nothing if no transactions (prevents empty epochs)
  }

  // Determine Deterministic Reference Time (minWallClock)
  // Since we have transactions, we can safely calculate min.
  const minWallClock = Math.min(...activeTxs.map((t) => t.ts.wallClock))

  // 2. Update watermarks based on OBSERVED active transactions
  let txCount = 0
  for (const { ts } of activeTxs) {
    const newWm = newWatermarks[ts.clientId]
      ? { ...newWatermarks[ts.clientId] }
      : { maxClock: -1, maxWallClock: 0 }

    if (ts.clock > newWm.maxClock) {
      newWm.maxClock = ts.clock
      newWm.maxWallClock = ts.wallClock
    }
    newWatermarks[ts.clientId] = newWm
    txCount++
  }

  // 3. Prune Inactive Watermarks (Deterministic)
  // Uses minWallClock so all clients agree on exactly who to prune.
  for (const clientId in newWatermarks) {
    if (minWallClock - newWatermarks[clientId].maxWallClock > retentionWindowMs) {
      delete newWatermarks[clientId]
    }
  }

  // 4. Save Checkpoint
  const cpKey = checkpointKeyToKey({
    epoch: activeEpoch,
    txCount,
    clientId: myClientId,
  })
  yCheckpoint.set(cpKey, {
    state: currentState,
    watermarks: newWatermarks,
    txCount,
    minWallClock,
  })

  // 5. Early Transaction Pruning (Optimization)
  // Delete all transactions from the now-finalized epoch
  // This reduces memory pressure instead of waiting for cleanupLog
  for (const key of yTx.keys()) {
    const { epoch } = parseTransactionTimestampKey(key)
    if (epoch <= activeEpoch) {
      yTx.delete(key)
    }
  }
}

/**
 * Garbage collects old checkpoints.
 * Should be called periodically to prevent unbounded growth of yCheckpoint.
 *
 * Keeps only the canonical checkpoint for the finalized epoch.
 * Everything else is deleted (old epochs + non-canonical).
 *
 * Note: The active epoch never has checkpoints - creating a checkpoint
 * for an epoch immediately makes it finalized.
 */
export function pruneCheckpoints(
  yCheckpoint: Y.Map<CheckpointRecord>,
  finalizedEpoch: number
): void {
  // Find the canonical checkpoint and its key in one pass
  let canonicalKey: CheckpointKey | null = null
  let bestTxCount = -1

  for (const [key] of yCheckpoint.entries()) {
    const { epoch, txCount } = parseCheckpointKey(key)
    if (epoch === finalizedEpoch && txCount > bestTxCount) {
      canonicalKey = key
      bestTxCount = txCount
    }
  }

  // Delete everything except the canonical checkpoint
  for (const key of yCheckpoint.keys()) {
    if (key !== canonicalKey) {
      yCheckpoint.delete(key)
    }
  }
}
