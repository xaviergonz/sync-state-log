import { JSONObject } from "./json"
import { ValidateFn } from "./operations"
import { StateCalculator } from "./StateCalculator"

/**
 * Client-side state including clocks and calculator for state management
 */
export interface ClientState {
  // Lamport clocks (monotonic, never reset)
  localClock: number

  // Cached finalized epoch (null = not yet initialized, recalculated only when checkpoint map changes)
  cachedFinalizedEpoch: number | null

  // State calculator (manages sorted tx cache, state calculation, and invalidation)
  stateCalculator: StateCalculator

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
    cachedFinalizedEpoch: null, // Will be recalculated on first run
    stateCalculator: new StateCalculator(validateFn),
    retentionWindowMs,
  }
}
