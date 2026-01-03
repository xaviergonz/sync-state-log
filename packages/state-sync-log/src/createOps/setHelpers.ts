/**
 * Helper functions for set-like array operations.
 */

import type { JSONValue } from "../json"
import { deepEqual } from "../utils"
import { ensureShallowCopy, getPath, getProxyDraft, markChanged } from "./utils"

/**
 * Add a value to an array if it doesn't already exist (set semantics).
 * Generates an `addToSet` operation.
 *
 * @example
 * ```ts
 * createOps(state, (draft) => {
 *   addToSet(draft.tags, 'newTag'); // Only adds if not present
 * });
 * ```
 */
export function addToSet<T extends JSONValue>(draft: T[], value: T): void {
  const proxyDraft = getProxyDraft(draft)
  if (!proxyDraft) {
    throw new Error(`addToSet() can only be used on draft arrays`)
  }

  // Get the path to this array
  const path = getPath(proxyDraft)
  if (!path) {
    throw new Error(`Cannot determine path for addToSet()`)
  }

  // Mark as changed
  ensureShallowCopy(proxyDraft)
  markChanged(proxyDraft)

  // The actual set semantics are handled by the operation application
  // We just record the operation - the draft state will reflect a push
  // but the op consumer handles deduplication
  const arr = proxyDraft.copy as T[]
  if (!arr.some((item) => item === value || deepEqual(item, value))) {
    arr.push(value)
  }

  // Mark this index as assigned (for finalization)
  proxyDraft.assignedMap!.set(String(arr.length - 1), true)
}

/**
 * Remove a value from an array (set semantics).
 * Generates a `deleteFromSet` operation.
 *
 * @example
 * ```ts
 * createOps(state, (draft) => {
 *   deleteFromSet(draft.tags, 'oldTag'); // Removes all matching items
 * });
 * ```
 */
export function deleteFromSet<T extends JSONValue>(draft: T[], value: T): void {
  const proxyDraft = getProxyDraft(draft)
  if (!proxyDraft) {
    throw new Error(`deleteFromSet() can only be used on draft arrays`)
  }

  // Get the path to this array
  const path = getPath(proxyDraft)
  if (!path) {
    throw new Error(`Cannot determine path for deleteFromSet()`)
  }

  // Mark as changed
  ensureShallowCopy(proxyDraft)
  markChanged(proxyDraft)

  // Remove all matching items (by value equality)
  const arr = proxyDraft.copy as T[]
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === value || deepEqual(arr[i], value)) {
      arr.splice(i, 1)
    }
  }
}
