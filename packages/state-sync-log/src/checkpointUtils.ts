import * as Y from "yjs"
import { type CheckpointRecord, type ClientWatermarks, parseCheckpointKey } from "./checkpoints"
import { parseTransactionTimestampKey, type TransactionTimestampKey } from "./transactionTimestamp"

/**
 * Determines the finalized epoch and its canonical checkpoint in a single pass.
 *
 * Policy A: The finalized epoch is the most recent epoch with a checkpoint.
 * Canonical checkpoint: The checkpoint with highest txCount for that epoch
 * (tie-break: lowest clientId alphabetically).
 *
 * Returns { finalizedEpoch: -1, checkpoint: null } if no checkpoints exist.
 */
export function getFinalizedEpochAndCheckpoint(yCheckpoint: Y.Map<CheckpointRecord>): {
  finalizedEpoch: number
  checkpoint: CheckpointRecord | null
} {
  let maxEpoch = -1
  let best: CheckpointRecord | null = null
  let bestTxCount = -1
  let bestClientId = ""

  for (const [key, cp] of yCheckpoint.entries()) {
    const { epoch, clientId } = parseCheckpointKey(key)

    if (epoch > maxEpoch) {
      // New highest epoch - reset best checkpoint tracking
      maxEpoch = epoch
      best = cp
      bestTxCount = cp.txCount
      bestClientId = clientId
    } else if (epoch === maxEpoch) {
      // Same epoch - check if this is a better canonical checkpoint
      // Primary: higher txCount wins
      // Secondary (tie-break): lower clientId (alphabetically) wins
      if (cp.txCount > bestTxCount || (cp.txCount === bestTxCount && clientId < bestClientId)) {
        best = cp
        bestTxCount = cp.txCount
        bestClientId = clientId
      }
    }
  }

  return { finalizedEpoch: maxEpoch, checkpoint: best }
}

/**
 * Checks if a transaction is covered by the checkpoint watermarks.
 */
export function isTransactionInCheckpoint(
  key: TransactionTimestampKey,
  watermarks: ClientWatermarks
): boolean {
  const ts = parseTransactionTimestampKey(key)
  const wm = watermarks[ts.clientId]
  if (!wm) return false
  return ts.clock <= wm.maxClock
}
