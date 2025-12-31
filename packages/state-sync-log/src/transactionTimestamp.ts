import { failure } from "./error"

/**
 * Parsed transaction timestamp components.
 */
export type TransactionTimestamp = {
  epoch: number
  clock: number
  clientId: string
  wallClock: number
}

/**
 * Unique Transaction ID (Composite Key).
 */
export type TransactionTimestampKey = string

/**
 * Converts a timestamp object to a TransactionTimestampKey string.
 */
export function transactionTimestampToKey(ts: TransactionTimestamp): TransactionTimestampKey {
  return `${ts.epoch};${ts.clock};${ts.clientId};${ts.wallClock}`
}

/**
 * Helper to parse transaction timestamp keys.
 * Throws if key is malformed.
 */
export function parseTransactionTimestampKey(key: TransactionTimestampKey): TransactionTimestamp {
  const i1 = key.indexOf(";")
  const i2 = key.indexOf(";", i1 + 1)
  const i3 = key.indexOf(";", i2 + 1)

  if (i1 === -1 || i2 === -1 || i3 === -1) {
    failure(`Malformed timestamp key: ${key}`)
  }

  return {
    epoch: Number.parseInt(key.substring(0, i1), 10),
    clock: Number.parseInt(key.substring(i1 + 1, i2), 10),
    clientId: key.substring(i2 + 1, i3),
    wallClock: Number.parseInt(key.substring(i3 + 1), 10),
  }
}

/**
 * Compares two transaction timestamps for deterministic ordering.
 * Sort order: epoch (asc) → clock (asc) → clientId (asc)
 */
export function compareTransactionTimestamps(
  a: TransactionTimestamp,
  b: TransactionTimestamp
): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  if (a.clock !== b.clock) return a.clock - b.clock
  if (a.clientId < b.clientId) return -1
  if (a.clientId > b.clientId) return 1
  return 0
}
