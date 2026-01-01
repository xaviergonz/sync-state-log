import { Op } from "./operations"
import type { TxTimestampKey } from "./txTimestamp"

/**
 * The immutable record stored in the Log.
 */
export type TxRecord = {
  ops: readonly Op[]
  /**
   * If this is a re-emit of a missed transaction, this field holds the
   * ORIGINAL key. Used for deduplication to prevent applying the same logical
   * action twice.
   */
  originalTxKey?: TxTimestampKey
}
