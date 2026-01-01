import { failure } from "./error"

/**
 * Parsed tx timestamp components.
 */
export type TxTimestamp = {
  epoch: number
  clock: number
  clientId: string
  wallClock: number
}

/**
 * Unique tx ID (Composite Key).
 */
export type TxTimestampKey = string

/**
 * Converts a timestamp object to a TransactionTimestampKey string.
 */
export function txTimestampToKey(ts: TxTimestamp): TxTimestampKey {
  return `${ts.epoch};${ts.clock};${ts.clientId};${ts.wallClock}`
}

/**
 * Helper to parse tx timestamp keys.
 * Throws if key is malformed.
 */
export function parseTxTimestampKey(key: TxTimestampKey): TxTimestamp {
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
 * Compares two tx timestamps for deterministic ordering.
 * Sort order: epoch (asc) → clock (asc) → clientId (asc)
 */
export function compareTxTimestamps(a: TxTimestamp, b: TxTimestamp): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  if (a.clock !== b.clock) return a.clock - b.clock
  if (a.clientId < b.clientId) return -1
  if (a.clientId > b.clientId) return 1
  return 0
}
